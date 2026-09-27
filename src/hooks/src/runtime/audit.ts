import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { debugLog } from './debug-log';
import { walkUp } from './path-utils';

// ---------------------------------------------------------------------------
// F3-4: guardrail audit trail.
//
// An append-only, local JSONL log of guardrail DECISIONS (deny / reconsider /
// advise / override-accepted / block) — never of raw command text, file
// content, or file paths. Every field that could carry that content is
// SHA-256 hashed before it is written (see `hashValue`).
//
// OFF by default (see `resolveAuditConfig`): consistent with this codebase's
// existing local-logging convention (`runtime/debug-log.ts` is likewise gated
// behind an explicit opt-in env var, `ROSETTA_DEBUG=1`) and with the
// "Zero-Telemetry by Default" posture documented in SECURITY.md. Enterprises
// that want the audit trail turn it on explicitly via `ROSETTA_AUDIT_LOG`.
//
// Write failures (unwritable dir, full disk, permission denied, …) must never
// break or slow the guardrail hook itself — every path below is wrapped so a
// failure here is swallowed and, at most, surfaced through the existing
// debug log (itself best-effort and off by default).
// ---------------------------------------------------------------------------

export type AuditDecision = 'advise' | 'deny' | 'override' | 'block';

export interface AuditRecordInput {
  /** The hook that made the decision, e.g. `dangerous-actions`. */
  hook: string;
  decision: AuditDecision;
  patternId: string | null;
  toolName: string;
  toolKind: string | null;
  ide: string;
  sessionId: string | null;
  /** Raw command text — hashed before writing, never stored. */
  command?: string | null;
  /** Raw file path — hashed before writing, never stored. */
  filePath?: string | null;
  /** Raw cwd — walked up to the nearest `.git` and hashed before writing. */
  cwd?: string | null;
}

interface AuditRecord {
  ts: string;
  hook: string;
  decision: AuditDecision;
  pattern_id: string | null;
  tool_name: string;
  tool_kind: string | null;
  ide: string;
  session_id: string | null;
  cmd_sha256: string | null;
  file_sha256: string | null;
  repo_sha256: string | null;
}

const DEFAULT_AUDIT_DIR = (): string => path.join(os.homedir(), '.rosetta', 'audit');
const MAX_AUDIT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — same cap as debug-log.ts

const OFF_VALUES = new Set(['off', '0', 'false', '']);
const DEFAULT_LOCATION_VALUES = new Set(['1', 'true', 'on']);

export interface AuditConfig {
  enabled: boolean;
  /** true when the target file is the default monthly-rotated one under `~/.rosetta/audit`. */
  useDefaultLocation: boolean;
  /** Only set when `ROSETTA_AUDIT_LOG` names an explicit path. */
  explicitPath: string | null;
}

/**
 * `ROSETTA_AUDIT_LOG` env surface:
 *   unset | "off" | "0" | "false" | ""  → disabled (the default)
 *   "1" | "true" | "on"                 → enabled, default location (`~/.rosetta/audit/YYYY-MM.jsonl`)
 *   <any other string>                  → enabled, that exact file path
 */
export const resolveAuditConfig = (env: Record<string, string | undefined> = process.env): AuditConfig => {
  const raw = env.ROSETTA_AUDIT_LOG;
  if (raw === undefined || OFF_VALUES.has(raw)) {
    return { enabled: false, useDefaultLocation: false, explicitPath: null };
  }
  if (DEFAULT_LOCATION_VALUES.has(raw)) {
    return { enabled: true, useDefaultLocation: true, explicitPath: null };
  }
  return { enabled: true, useDefaultLocation: false, explicitPath: raw };
};

const monthlyFileName = (d = new Date()): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;

const resolveTargetPath = (cfg: AuditConfig): string =>
  cfg.useDefaultLocation ? path.join(DEFAULT_AUDIT_DIR(), monthlyFileName()) : (cfg.explicitPath as string);

const hashValue = (value: string | null | undefined): string | null => {
  if (value == null || value === '') return null;
  try {
    const salt = process.env.ROSETTA_AUDIT_SALT ?? '';
    return crypto.createHash('sha256').update(salt + value, 'utf8').digest('hex');
  } catch {
    return null;
  }
};

/** Best-effort repo-root resolution: nearest `.git` above `cwd`, else `cwd` itself. Never throws. */
const resolveRepoRootForHash = (cwd: string | null | undefined): string | null => {
  if (!cwd) return null;
  try {
    return walkUp(cwd, '.git') ?? cwd;
  } catch {
    return cwd;
  }
};

const ensureDirFor = (filePath: string): void => {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  } catch {
    // Directory already exists, or unwritable — the append below will surface (and swallow) that.
  }
};

const rotateIfNeeded = (filePath: string): void => {
  try {
    if (statSync(filePath).size >= MAX_AUDIT_FILE_BYTES) {
      renameSync(filePath, `${filePath}.1`);
    }
  } catch {
    // File doesn't exist yet, or rotation failed — not fatal, next append just keeps growing it.
  }
};

/**
 * Append one guardrail-decision record. Always safe to call: disabled (the default) is a no-op,
 * and any failure while resolving the target path, creating the directory, rotating, hashing, or
 * writing is swallowed so the calling hook's decision is never delayed or broken by logging.
 */
export const appendAuditRecord = (
  input: AuditRecordInput,
  env: Record<string, string | undefined> = process.env,
): void => {
  try {
    const cfg = resolveAuditConfig(env);
    if (!cfg.enabled) return;

    const filePath = resolveTargetPath(cfg);
    if (!filePath) return;

    ensureDirFor(filePath);
    rotateIfNeeded(filePath);

    const record: AuditRecord = {
      ts: new Date().toISOString(),
      hook: input.hook,
      decision: input.decision,
      pattern_id: input.patternId,
      tool_name: input.toolName,
      tool_kind: input.toolKind,
      ide: input.ide,
      session_id: input.sessionId,
      cmd_sha256: hashValue(input.command),
      file_sha256: hashValue(input.filePath),
      repo_sha256: hashValue(resolveRepoRootForHash(input.cwd)),
    };

    appendFileSync(filePath, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch (err) {
    try {
      debugLog('audit:write-failed', { error: (err as Error)?.message });
    } catch {
      // Never let audit logging break or throw out of the hook, even while logging its own failure.
    }
  }
};
