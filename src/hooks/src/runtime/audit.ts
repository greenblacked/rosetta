import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
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
// keyed-hashed before it is written (see `hashValue` / P2-7 below).
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
  /** P2-7: whether the hashes above are keyed (HMAC, with `ROSETTA_AUDIT_SALT` or the
   *  auto-generated per-install key) or, only on the best-effort fallback where neither could
   *  be obtained, plain unsalted SHA-256 — a reader needs to know which, since only the keyed
   *  form resists a guessable-input dictionary attack. */
  keyed: boolean;
}

const DEFAULT_AUDIT_DIR = (): string => path.join(os.homedir(), '.rosetta', 'audit');
const MAX_AUDIT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — same cap as debug-log.ts
const MAX_ROTATED_FILES = 5;

const OFF_VALUES = new Set(['off', '0', 'false', '']);
const DEFAULT_LOCATION_VALUES = new Set(['1', 'true', 'on', 'yes']);

export interface AuditConfig {
  enabled: boolean;
  /** true when the target file is the default monthly-rotated one under `~/.rosetta/audit`. */
  useDefaultLocation: boolean;
  /** Only set when `ROSETTA_AUDIT_LOG` names an explicit, absolute file path. */
  explicitPath: string | null;
}

/**
 * `ROSETTA_AUDIT_LOG` env surface (P3: matching is case-insensitive — `TRUE`, `Yes`, `On`, `1`
 * all mean the default location, same as their lowercase forms):
 *   unset | "off" | "0" | "false" | ""        → disabled (the default)
 *   "1" | "true" | "on" | "yes" (any case)    → enabled, default location (`~/.rosetta/audit/YYYY-MM.jsonl`)
 *   any other ABSOLUTE path                    → enabled, that exact file path
 *   any other RELATIVE value                   → disabled — a relative path would resolve
 *                                                against the hook process's cwd, which is
 *                                                normally somewhere inside the user's repo;
 *                                                silently writing the audit log INTO the repo
 *                                                being worked on is exactly the footgun this
 *                                                guards against. Logged via debugLog, never
 *                                                thrown.
 */
export const resolveAuditConfig = (env: Record<string, string | undefined> = process.env): AuditConfig => {
  const raw = env.ROSETTA_AUDIT_LOG;
  if (raw === undefined) return { enabled: false, useDefaultLocation: false, explicitPath: null };

  const normalized = raw.trim().toLowerCase();
  if (OFF_VALUES.has(normalized)) return { enabled: false, useDefaultLocation: false, explicitPath: null };
  if (DEFAULT_LOCATION_VALUES.has(normalized)) return { enabled: true, useDefaultLocation: true, explicitPath: null };

  if (path.isAbsolute(raw)) return { enabled: true, useDefaultLocation: false, explicitPath: raw };

  debugLog('audit:relative-path-ignored', { value: raw });
  return { enabled: false, useDefaultLocation: false, explicitPath: null };
};

const monthlyFileName = (d = new Date()): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;

const resolveTargetPath = (cfg: AuditConfig): string =>
  cfg.useDefaultLocation ? path.join(DEFAULT_AUDIT_DIR(), monthlyFileName()) : (cfg.explicitPath as string);

// --- P2-7: keyed hashing --------------------------------------------------------

const AUDIT_KEY_FILENAME = '.key';
const AUDIT_KEY_BYTES = 32;

/** The directory the per-install key lives under. Takes `env.HOME` when set (letting tests
 *  sandbox key creation away from the real machine's home directory, the same way the rest of
 *  this module is env-injectable) and otherwise `os.homedir()` — matching `DEFAULT_AUDIT_DIR`'s
 *  own resolution for the log file itself. */
const defaultAuditKeyDir = (env: Record<string, string | undefined>): string =>
  path.join(env.HOME || os.homedir(), '.rosetta', 'audit');

/** Reads the per-install audit-hash key, creating it (best-effort, mode 0600) if it doesn't
 *  exist yet. Lives under the DEFAULT audit dir, independent of where the log itself is written
 *  (`ROSETTA_AUDIT_LOG` can point anywhere) — it's a per-install secret, not per-target. Never
 *  throws: any failure (unwritable dir, a racing sibling process that created it first and whose
 *  content we then can't read either, …) falls back to `null`, and the caller then falls back to
 *  unsalted hashing and marks the record `keyed: false`. */
const readOrCreateInstallKey = (env: Record<string, string | undefined>): Buffer | null => {
  const keyDir = defaultAuditKeyDir(env);
  const keyPath = path.join(keyDir, AUDIT_KEY_FILENAME);
  try {
    const existing = readFileSync(keyPath);
    if (existing.length > 0) return existing;
  } catch {
    // doesn't exist yet (or unreadable) — fall through to create.
  }
  try {
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(AUDIT_KEY_BYTES);
    // 'wx' — create-exclusive: never clobbers a key a concurrent process just wrote.
    writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
    return key;
  } catch {
    // Most likely: another process won the race and created it first. Try reading once more
    // before giving up.
    try {
      const existing = readFileSync(keyPath);
      if (existing.length > 0) return existing;
    } catch {
      // give up — caller falls back to unsalted.
    }
    return null;
  }
};

interface HashKey {
  key: Buffer | null;
  keyed: boolean;
}

/** `ROSETTA_AUDIT_SALT` (from the INJECTED env, never `process.env` directly — so this is
 *  testable and so a real deployment's key resolution is fully determined by what was actually
 *  passed in) wins if set and non-empty; otherwise the auto-created per-install key; otherwise
 *  (both unavailable) unsalted, with `keyed: false` on every record so a reader can tell. */
const resolveHashKey = (env: Record<string, string | undefined>): HashKey => {
  const salt = env.ROSETTA_AUDIT_SALT;
  if (salt) return { key: Buffer.from(salt, 'utf8'), keyed: true };
  const installKey = readOrCreateInstallKey(env);
  return { key: installKey, keyed: installKey !== null };
};

const hashValue = (value: string | null | undefined, key: Buffer | null): string | null => {
  if (value == null || value === '') return null;
  try {
    return key
      ? crypto.createHmac('sha256', key).update(value, 'utf8').digest('hex')
      : crypto.createHash('sha256').update(value, 'utf8').digest('hex');
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

// --- P3: rotation without clobbering a prior rotated file ------------------------

/** Filesystem-safe, fixed-width, lexicographically-sortable-in-time-order timestamp for a
 *  rotated file's name, e.g. `2026-09-27T12-00-00-000Z`. */
const rotationStamp = (d = new Date()): string => d.toISOString().replace(/[:.]/g, '-');

/** Deletes the oldest rotated files for `stem`/`ext` in `dir` beyond `MAX_ROTATED_FILES`. Purely
 *  best-effort: a failure here (can't list the dir, can't delete a file) never throws — it just
 *  means one extra rotated file lingers past the cap until the next rotation. */
const pruneOldRotations = (dir: string, stem: string, ext: string): void => {
  try {
    const prefix = `${stem}.`;
    const rotated = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(ext) && name !== `${stem}${ext}`)
      .sort(); // the timestamp suffix is fixed-width and monotonic, so lexicographic === chronological.
    for (let i = 0; i < rotated.length - MAX_ROTATED_FILES; i++) {
      try {
        unlinkSync(path.join(dir, rotated[i]));
      } catch {
        // best-effort prune — leave it, try again next rotation.
      }
    }
  } catch {
    // best-effort prune.
  }
};

/** Once `filePath` reaches the size cap, renames it to a TIMESTAMPED `.N`-free sibling
 *  (`<stem>.<timestamp><ext>`) instead of always renaming to a fixed `${filePath}.1` — which
 *  used to silently OVERWRITE whatever a previous rotation had left there. Keeps at most the
 *  last `MAX_ROTATED_FILES` rotated files (see `pruneOldRotations`). */
const rotateIfNeeded = (filePath: string): void => {
  try {
    if (statSync(filePath).size < MAX_AUDIT_FILE_BYTES) return;
  } catch {
    return; // file doesn't exist yet — nothing to rotate.
  }
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    const rotatedPath = path.join(dir, `${stem}.${rotationStamp()}${ext}`);
    renameSync(filePath, rotatedPath);
    pruneOldRotations(dir, stem, ext);
  } catch {
    // Rotation failed — not fatal, next append just keeps growing (or fails writing) the
    // original file; the write itself is wrapped separately in `appendAuditRecord`.
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

    const { key, keyed } = resolveHashKey(env);

    const record: AuditRecord = {
      ts: new Date().toISOString(),
      hook: input.hook,
      decision: input.decision,
      pattern_id: input.patternId,
      tool_name: input.toolName,
      tool_kind: input.toolKind,
      ide: input.ide,
      session_id: input.sessionId,
      cmd_sha256: hashValue(input.command, key),
      file_sha256: hashValue(input.filePath, key),
      repo_sha256: hashValue(resolveRepoRootForHash(input.cwd), key),
      keyed,
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
