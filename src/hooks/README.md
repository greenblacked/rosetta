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
| `1` / `true` / `on` | enabled, default location: `~/.rosetta/audit/YYYY-MM.jsonl` (rotated monthly, plus a 10 MB size cap per file) |
| any other string | enabled, written to that exact file path (still size-capped/rotated) |

Optional `ROSETTA_AUDIT_SALT` is prepended before hashing (see below) — set it org-wide to
make the hashes non-comparable to an attacker who doesn't know the salt.

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
  "repo_sha256": "…"
}
```

`cmd_sha256` / `file_sha256` / `repo_sha256` are SHA-256 hashes — the raw command, file path,
and repo root (nearest `.git` above `cwd`, else `cwd`) are **never** written. A write failure
(unwritable directory, full disk, permission denied, …) is swallowed; it never breaks or
delays the guardrail decision itself.

**Why off by default:** consistent with this codebase's existing local-logging convention
(`runtime/debug-log.ts` is likewise gated behind an explicit `ROSETTA_DEBUG=1`) and with the
"Zero-Telemetry by Default" posture in `SECURITY.md`. Turn it on explicitly for compliance
evidence (SOC2/ISO control operation).

## Org policy overlay (F3-3)

`dangerous-actions` patterns can be tuned per organization/project via a `rosetta-policy.json`
file, resolved with precedence **managed > project > built-in**:

| Layer | Location | Authority |
|---|---|---|
| managed | `ROSETTA_POLICY_FILE` env, else `/etc/rosetta/policy.json` (`%ProgramData%\Rosetta\policy.json` on Windows) | full — can add patterns, raise/lower any tier, disable (`"off"`) a built-in pattern id |
| project | `<repo-root>/.rosetta/policy.json` (nearest `.git` above `cwd`, else `cwd`) | **tighten-only** — can add new patterns freely; can only *raise* an already-effective tier, never lower or disable one |

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
- `override`: pattern id → new tier, or `"off"` to disable (managed layer only).
- **`block`** is a new hard-deny tier, reachable only through policy (there is still no
  built-in hard-deny — see `dangerous-actions/patterns.ts`). Unlike `reconsider`, the
  `Rosetta-AI-reviewed` marker is **never** consulted for a `block`-tier match.

**Safety, since org regexes run on every tool call:** each added pattern is compiled at load
time (a pattern that fails to compile is dropped); a simple nested-quantifier heuristic
rejects classic catastrophic-backtracking shapes (e.g. `(a+)+`); regex source length and the
number of added patterns per file are capped. At match time, an org-supplied pattern (added,
or one that overrode a built-in id) is only tested against a bounded prefix of the candidate
string — built-in patterns are untouched, since they already carry their own anti-quadratic
invariants and scaling tests. A missing policy file is normal and silent; a present-but-invalid
one (bad JSON, wrong shape) is logged once (best-effort, via the existing debug log) and that
layer's policy is dropped — evaluation always falls back to the other layer / the built-ins,
never crashes.
