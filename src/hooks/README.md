# Rosetta hooks — enterprise guardrail extensions

This file documents two opt-in, enterprise-facing extensions to the `dangerous-actions` hook.
For the hook runtime itself (adapters, event/tool-kind mapping, the `Rosetta-AI-reviewed`
marker, pattern shapes) see `src/hooks/src/hooks/dangerous-actions/`.

## Guardrail audit trail (F3-4)

An append-only, local JSONL log of guardrail **decisions** — never of raw command text, file
content, or file paths. Every guardrail decision from `dangerous-actions` (`advise`, `deny`
(reconsider tier), `override` (marker honored), `block` (org-policy hard-deny)) appends one
record.

**Off by default.** Enable it with `ROSETTA_AUDIT_LOG`:

| Value | Effect |
|---|---|
| unset / `off` / `0` / `false` / `""` | disabled (default) |
| `1` / `true` / `on` / `yes` (case-insensitive) | enabled, default location: `~/.rosetta/audit/YYYY-MM.jsonl` (rotated monthly, plus a 10 MB size cap per file) |
| any other ABSOLUTE path | enabled, written to that exact file path (still size-capped/rotated) |
| any other RELATIVE value | ignored (treated as disabled) — a relative value would resolve against the hook process's cwd, which is normally inside the repo being worked on; this avoids silently writing the audit log into the user's own repository |

Hashes are **keyed** (HMAC-SHA256), not plain SHA-256 — plain SHA-256 of a common command or
path (`rm -rf /`, `~/.aws/credentials`, …) is a guessable-dictionary target even without knowing
the input, since there's no secret in the hash at all. The key, in order of preference:

1. `ROSETTA_AUDIT_SALT`, if set — an org-wide secret, so hashes are comparable across a fleet
   (same command → same hash) but not reversible/guessable by anyone outside the org.
2. Otherwise, a random 32-byte key is auto-created on first use at
   `~/.rosetta/audit/.key` (mode `0600`, best-effort) and reused after that — hashes are then
   comparable *on this machine* but not across machines.
3. If neither is available (the key couldn't be created or read), records fall back to plain,
   unsalted SHA-256 and mark `"keyed": false` so a reader of the log can tell the hashes in that
   record are the weaker, guessable form.

Record shape (one JSON object per line):

```json
{
  "ts": "2026-09-27T12:00:00.000Z",
  "hook": "dangerous-actions",
  "decision": "deny",
  "pattern_id": "rm-rf-root",
  "tool_name": "Bash",
  "tool_kind": "bash",
  "ide": "claude-code",
  "session_id": "…",
  "cmd_sha256": "…",
  "file_sha256": null,
  "repo_sha256": "…",
  "keyed": true
}
```

`cmd_sha256` / `file_sha256` / `repo_sha256` are (keyed) SHA-256 hashes — the raw command, file
path, and repo root (nearest `.git` above `cwd`, else `cwd`) are **never** written. A write
failure (unwritable directory, full disk, permission denied, …) is swallowed; it never breaks or
delays the guardrail decision itself.

Once a log file reaches the 10 MB cap it is rotated to a timestamped sibling
(`<name>.<UTC-timestamp>.jsonl`, e.g. `2026-09.2026-09-27T12-00-00-000Z.jsonl`) rather than a
fixed `.1` suffix, so an earlier rotation is never silently overwritten; only the 5 most recent
rotated files are kept.

**Why off by default:** consistent with this codebase's existing local-logging convention
(`runtime/debug-log.ts` is likewise gated behind an explicit `ROSETTA_DEBUG=1`) and with the
"Zero-Telemetry by Default" posture in `SECURITY.md`. Turn it on explicitly for compliance
evidence (SOC2/ISO control operation).

## Org policy overlay (F3-3)

`dangerous-actions` patterns can be tuned per organization/project via a policy overlay file
(`.rosetta/policy.json` for the project layer — see the table below for the managed layer's
location), resolved with precedence **managed > project > built-in**:

| Layer | Location | Authority |
|---|---|---|
| managed | `ROSETTA_POLICY_FILE` env, else `/etc/rosetta/policy.json` (`%ProgramData%\Rosetta\policy.json` on Windows) | full *if the file passes the trust check below* — can add patterns, raise/lower any tier, disable (`"off"`) a built-in pattern id. Otherwise silently downgraded to **tighten-only**, same as the project layer. |
| project | `<repo-root>/.rosetta/policy.json` (nearest `.git` above `cwd`, else `cwd`) | **tighten-only** — can add new patterns freely; can only *raise* an already-effective tier (including up to `block`), never lower or disable one |

**Managed-layer trust (P2-6):** the managed layer's full authority (including disabling a
built-in guard outright) only means anything if the file itself is actually admin-controlled —
`ROSETTA_POLICY_FILE` can be set by repo-committed IDE/editor settings, and even the
platform-default location isn't automatically locked down. So:
- **POSIX:** a candidate managed file (default path OR `ROSETTA_POLICY_FILE`) is trusted as
  "managed" only when it is **owned by uid 0** and **not group- or world-writable**. Otherwise
  it's loaded with project (tighten-only) authority instead, and why is written to the debug
  log.
- **Windows:** there's no cheap, dependency-free ACL check available. The platform-default path
  (`%ProgramData%\Rosetta\policy.json`) is trusted as managed on the assumption that MDM
  provisioned that directory with an **admin-only ACL** — if you deploy this via MDM on Windows,
  you must set that ACL yourself; Rosetta does not verify it. A `ROSETTA_POLICY_FILE` override
  on Windows is always tighten-only (project authority) instead, since that env var is exactly
  the attacker-controllable input this check exists for.

Schema:

```json
{
  "patterns": {
    "add": [
      { "id": "vault-delete", "regex": "\\bvault\\s+delete\\b", "tier": "reconsider",
        "reason": "internal secrets store deletion", "appliesTo": ["bash"] }
    ],
    "override": { "rm-rf-root": "block", "ssh-private-key": "off" }
  }
}
```

- `tier`: `advise` | `reconsider` | `block` (added patterns; `off` is override-only).
- `appliesTo`: `["bash", "content"]` (default) — whether the added pattern is tested against
  raw shell commands, content written to files, or both.
- `override`: pattern id → new tier, or `"off"` to disable (managed layer only — and even then
  only once that file has passed the trust check above; a project override can also raise a
  pattern's tier all the way to `block`, it just can never set `"off"`).
- **`block`** is a new hard-deny tier, reachable only through a policy overlay — a trusted
  managed policy directly, or a project policy *tightening* an already-effective tier up to
  `block` (there is still no built-in hard-deny — see `dangerous-actions/patterns.ts`). Unlike
  `reconsider`, the `Rosetta-AI-reviewed` marker is **never** consulted for a `block`-tier match.

**Safety, since org regexes run on every tool call:**
- Each added pattern is compiled at load time, and its SHAPE is checked against a conservative
  syntax allowlist (a pattern that fails either check is dropped): a quantifier (`*`, `+`, `?`,
  `{n,m}`, `{n,}`) may only follow a single atom (a literal character, an escape like `\s`/`\d`,
  or a character class), never a group — so `(a+)+`, `(a|a)*$`, `((a+))+$` and `(a+){2,}` are all
  rejected outright, not pattern-matched for a specific known-bad shape. Backreferences and
  lookaround are rejected too, and groups may nest at most 2 deep. Regex source length and the
  number of added patterns per file are also capped.
- At match time, every applicable pattern (bash, content, and — for Write/Edit — path patterns)
  is evaluated, and the STRICTEST matching tier wins (`block` > `reconsider` > `advise`) — a
  laxer built-in match can no longer shadow a stricter org-policy match on the same input.
- An org-supplied pattern (added, or one that overrode a built-in id) is tested per
  shell-segment (split on `;`, `&&`, `||`, `|`, and line breaks) against a bounded prefix of each
  segment, rather than a bounded prefix of the whole string — so a short dangerous segment can't
  hide behind a long harmless one ahead of it. If a single segment still exceeds that bound and
  an org `block`/`reconsider` pattern applies to this category, the evaluation fails CLOSED to
  `reconsider` instead of silently allowing the unverifiable remainder through. Built-in patterns
  are untouched by any of this — they already carry their own anti-quadratic invariants and
  scaling tests.
- A missing policy file is normal and silent; a present-but-invalid one (bad JSON, wrong shape)
  is logged (best-effort, via the existing debug log) and that layer's policy is dropped —
  evaluation always falls back to the other layer / the built-ins, never crashes.
