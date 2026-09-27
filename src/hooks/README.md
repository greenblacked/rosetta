# Rosetta hooks — enterprise guardrail extensions

This file documents opt-in, enterprise-facing extensions to the `dangerous-actions` hook.
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
