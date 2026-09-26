// Implements FR-SHRD-0009 (read resilience with retry) and FR-PLAN-0024 (atomic write with rename-as-guard).
// Generalized from plan-io.ts so both `plan` and `specs` share one file-IO implementation
// (FR-SPECS-0070/0071) — bodies are unchanged except the error-code source, which is now an
// optional parameter defaulting to plan's exact strings so plan behavior is byte-identical.

import * as fs from "fs";
import * as path from "path";
import type { RunEnvelope } from "../registry/types.js";
import { err } from "./envelope.js";
import { logger } from "./logger.js";
import {
  PLAN_BACKUP_RETENTION,
  PLAN_BACKUP_MAX_RETRIES,
  PLAN_READ_RETRY_DELAY_MS,
  PLAN_READ_MAX_RETRIES,
} from "./constants.js";
import { ERR_BACKUP_CREATE_FAILED } from "./errors.js";

// ---------------------------------------------------------------------------
// Error-code parameterization (§6.1) — plan callers pass no `errors` and get
// byte-identical behavior; specs passes its own corrupted/not-found codes.
// ---------------------------------------------------------------------------

export interface DocIoErrors {
  corrupted?: string;
  notFound?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns all backup file names (just the basename, not full path) for a document file. */
function listBackups(dir: string, basename: string): string[] {
  try {
    const entries = fs.readdirSync(dir);
    // FR-PLAN-0024 — backup naming convention: <basename>.bakNNN
    return entries.filter((e) => /^.+\.bak\d+$/.test(e) && e.startsWith(basename + ".bak"));
  } catch {
    return [];
  }
}

/** Parses the NNN suffix from a backup name like "plan.json.bak042" → 42. Returns -1 if invalid. */
function parseBackupIndex(basename: string, backupName: string): number {
  const prefix = basename + ".bak";
  if (!backupName.startsWith(prefix)) return -1;
  const suffix = backupName.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return -1;
  return parseInt(suffix, 10);
}

/** Computes next backup path: finds max existing index + 1. */
function nextBackupPath(filePath: string): string {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const backups = listBackups(dir, basename);
  let maxIdx = -1;
  for (const b of backups) {
    const idx = parseBackupIndex(basename, b);
    if (idx > maxIdx) maxIdx = idx;
  }
  const nextIdx = maxIdx + 1;
  // FR-PLAN-0024 step 3 — 3-digit zero-padded for cosmetics
  const padded = String(nextIdx).padStart(3, "0");
  return path.join(dir, `${basename}.bak${padded}`);
}

/** Prunes oldest backups beyond retention count. FR-PLAN-0024 step 7. */
function pruneBackups(filePath: string, retention: number): void {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  const backups = listBackups(dir, basename);
  if (backups.length <= retention) return;

  // Sort by index ascending — oldest first
  const sorted = backups
    .map((b) => ({ name: b, idx: parseBackupIndex(basename, b) }))
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx);

  const toDelete = sorted.slice(0, sorted.length - retention);
  for (const { name } of toDelete) {
    try {
      fs.unlinkSync(path.join(dir, name));
      logger.info({ file: name }, "pruned old backup");
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Public: Read with resilience (FR-SHRD-0009)
// ---------------------------------------------------------------------------

/**
 * Reads the document file.
 * - If file exists: parse and return it; injects previous_version=null if missing (back-compat).
 * - If file missing AND backup exists: sleep PLAN_READ_RETRY_DELAY_MS, retry up to PLAN_READ_MAX_RETRIES.
 * - If file missing AND no backup: return null immediately.
 * - If parse fails: throws (caller converts to a corrupted-error code).
 *
 * A3 (FR-SHRD-0009 / FR-PLAN-0024): reads via readFileSync directly instead of an
 * existsSync-then-readFileSync pair, which left a time-of-check/time-of-use gap — a concurrent
 * writer's tmp-file rename (see writeDocAtomic) could remove the file between the two calls,
 * and a plain ENOENT from readFileSync was previously indistinguishable from a real parse
 * failure. ENOENT is now treated exactly like "file missing" (continues the retry loop below);
 * any other error (e.g. a JSON.parse SyntaxError) still throws so callers keep mapping it to
 * their corrupted-error code.
 */
export async function readDocWithRetry<Doc extends { previous_version?: string | null }>(
  filePath: string,
): Promise<Doc | null> {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);

  for (let attempt = 0; attempt <= PLAN_READ_MAX_RETRIES; attempt++) {
    let raw: Doc | undefined;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Doc;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw e; // parse failure or other unexpected fs error — bubble up
      // ENOENT falls through to the "file missing" handling below
    }

    if (raw !== undefined) {
      // FR-SHRD-0009 — file present, parsed successfully
      // FR-PLAN-0017 — back-compat: inject previous_version:null if absent
      if (!("previous_version" in raw)) {
        (raw as Record<string, unknown>)["previous_version"] = null;
      }
      return raw;
    }

    // File missing — check for backups
    const backups = listBackups(dir, basename);
    if (backups.length === 0) {
      // FR-SHRD-0009 — no backup, return immediately
      return null;
    }

    if (attempt >= PLAN_READ_MAX_RETRIES) {
      // Exhausted retries
      return null;
    }

    // FR-SHRD-0009 — backup exists, wait and retry
    logger.info({ filePath, attempt }, "document file missing but backup exists, retrying read");
    await new Promise<void>((resolve) => setTimeout(resolve, PLAN_READ_RETRY_DELAY_MS));
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public: atomic write via tmp-file + rename (A3 / FR-PLAN-0024, FR-SHRD-0009)
// ---------------------------------------------------------------------------

/**
 * Writes `content` to `filePath` by first writing a uniquely-named temp file in the same
 * directory, then renaming it into place. POSIX rename is atomic, so a concurrent reader
 * (readDocWithRetry, or any plain readFileSync) always observes either the old content in full
 * or the new content in full — never a partial write. Used by savePlan/saveSpecs so readers
 * polling `plan next` / `specs query` while a writer is in flight never see truncated JSON
 * (A3 / FR-PLAN-0024). The temp file's `.tmp-<pid>-<rand>` naming is deliberately excluded from
 * `listBackups`'s `.bakNNN` pattern, so it is never mistaken for a backup.
 */
export function writeDocAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `${path.basename(filePath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Public: Atomic write with backup chain (FR-PLAN-0024)
// ---------------------------------------------------------------------------

// A process holding the `.lock` mkdir mutex longer than this is treated as crashed and its
// lock forcibly reclaimed (A2/FR-PLAN-0024). Shared by atomicWriteWithBackup and
// createDocExclusive so both writers serialize against the very same mutex.
const LOCK_STALE_MS = 30_000;
const LOCK_SPIN_MS = 20;

/**
 * One attempt to acquire the `<filePath>.lock` mkdir mutex (A2/FR-PLAN-0024 step 0a). Returns
 * `true` once this call has created the lock directory (caller now holds it); returns `false`
 * after handling a failed attempt (EEXIST contention, possibly reclaiming a stale lock, or a
 * transient non-EEXIST mkdir error) and sleeping a short, jittered spin delay — the caller is
 * expected to loop and retry. Factored out of atomicWriteWithBackup so createDocExclusive can
 * take the exact same mutex without re-implementing the stale-lock reclaim logic.
 */
async function tryAcquireLockOnce(lockPath: string): Promise<boolean> {
  try {
    fs.mkdirSync(lockPath);
    return true;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST") {
      logger.warn({ lockPath, error: String(e) }, "lock acquire failed (non-EEXIST), restarting");
      await new Promise<void>((r) => setTimeout(r, LOCK_SPIN_MS));
      return false;
    }
    // EEXIST: another writer holds the lock — or its previous holder crashed.
    try {
      const stat = fs.statSync(lockPath);
      const age = Date.now() - stat.mtimeMs;
      if (age > LOCK_STALE_MS) {
        logger.warn({ lockPath, ageMs: age }, "removing stale lock");
        try { fs.rmdirSync(lockPath); } catch { /* race with another writer is fine */ }
      }
    } catch {
      // lock disappeared between EEXIST and statSync — race is fine, just retry
    }
    await new Promise<void>((r) => setTimeout(r, LOCK_SPIN_MS + Math.floor(Math.random() * LOCK_SPIN_MS)));
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // best-effort
  }
}

/**
 * A2/FR-PLAN-0024 — takes the same `.lock` mkdir mutex as atomicWriteWithBackup and performs an
 * exclusive first-ever create: `buildDoc()` is only invoked, and only saved, while holding the
 * lock and only after re-checking that `filePath` is still missing. This closes the race where
 * two processes both observe a missing file (via `fs.existsSync`) before either has taken the
 * lock, and both then call `saveDoc` directly — the loser's write previously clobbered or was
 * clobbered by the winner's, depending on OS write scheduling, with no lock in between.
 *
 * Returns `{ created: true }` once this call's document has been written. Returns
 * `{ created: false }` either because the file already existed once the lock was held (another
 * process created it first) or because the lock could not be acquired within `maxRetries`
 * attempts; either way, the caller MUST fall through to `atomicWriteWithBackup`, which re-takes
 * the same lock and merges against whatever now exists on disk.
 */
export async function createDocExclusive<Doc>(
  filePath: string,
  buildDoc: () => Doc,
  saveDoc: (filePath: string, doc: Doc) => void,
  maxRetries = PLAN_BACKUP_MAX_RETRIES,
): Promise<{ created: true } | { created: false }> {
  const lockPath = filePath + ".lock";

  // The `.lock` mutex is a sibling of filePath, so its parent directory must exist before
  // mkdirSync(lockPath) can succeed — mirrors savePlan/saveSpecs, which both create it too.
  // Safe under concurrent first-creates: mkdirSync(..., {recursive:true}) never throws EEXIST.
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const acquired = await tryAcquireLockOnce(lockPath);
    if (!acquired) continue;

    try {
      // Re-check inside the lock: another process may have created the file while we were
      // spinning for the lock, or between our caller's own existsSync check and this call.
      if (fs.existsSync(filePath)) return { created: false };
      saveDoc(filePath, buildDoc());
      return { created: true };
    } finally {
      releaseLock(lockPath);
    }
  }

  // Could not acquire the lock at all — let the caller fall through to atomicWriteWithBackup,
  // which has its own (larger) retry budget for lock contention.
  return { created: false };
}

/**
 * Wraps a document mutation in the rename-as-guard write cycle (FR-PLAN-0024).
 *
 * Used only when an existing document file is being mutated. First-ever create writes
 * (file does not yet exist) bypass this helper and call the caller's save function directly
 * with previous_version=null, per FR-PLAN-0024 ("first-ever create: skip steps 1, 3, 5, 7").
 *
 * Retry loop bounded to PLAN_BACKUP_MAX_RETRIES.
 * Any failure within the cycle restarts from step 1.
 * Mutation returning ok:false bubbles immediately (logic error, not a write failure).
 */
export async function atomicWriteWithBackup<Doc extends { previous_version?: string | null; updated_at: string }, T>(
  filePath: string,
  mutate: (doc: Doc) => { ok: true; result: T; updated: Doc } | { ok: false; error: string; include_help?: boolean },
  saveDoc: (filePath: string, doc: Doc) => void,
  options?: { maxRetries?: number; retention?: number; errors?: DocIoErrors; mutatorIgnoresCurrent?: boolean },
): Promise<RunEnvelope<{ result: T; backupPath: string | null }>> {
  const maxRetries = options?.maxRetries ?? PLAN_BACKUP_MAX_RETRIES;
  const retention = options?.retention ?? PLAN_BACKUP_RETENTION;
  const corruptedError = options?.errors?.corrupted ?? "plan_file_corrupted";
  const notFoundError = options?.errors?.notFound ?? "plan_not_found";
  // R4 — `mutatorIgnoresCurrent` is for callers whose `mutate()` rebuilds the document from
  // scratch and never reads `current` at all (e.g. `plan create` re-running against an existing
  // path). For those callers a corrupted or missing current document is not fatal: skip parsing
  // it and still run the rename-as-guard cycle below, which backs up whatever raw bytes are on
  // disk (corrupted or not — see step 5) and writes the freshly-built document, so `create` never
  // gets permanently stuck behind a truncated plan.json. A non-JSON-parse read failure (e.g.
  // EISDIR from a directory at `filePath`) still returns `corruptedError` unconditionally: that
  // is not a recoverable "corrupted document", it is a fundamentally unwritable path.
  const mutatorIgnoresCurrent = options?.mutatorIgnoresCurrent ?? false;

  // FR-PLAN-0024 write cycle. The FR statement names rename-as-guard, but neither plain
  // renameSync (POSIX rename overwrites the target — clobbers another writer's bak) nor
  // hardlink claim (two writers can both hardlink the same source inode before either
  // unlinks it; the second's unlink then destroys the first's freshly-written file) actually
  // serializes concurrent writers in a multi-process scenario (verified by MPP test: 3/30
  // lost writes with hardlink; 1/10 with plain rename). The only POSIX primitive that
  // gives true exclusion across processes is an atomic-create primitive. mkdir(2) creates
  // a directory atomically and fails with EEXIST if the path exists, so we use a `.lock`
  // directory as a mutex around the entire read-mutate-rename-write cycle. Inside the lock
  // the simpler renameSync semantics suffice because no other writer can be in the cycle.
  const lockPath = filePath + ".lock";
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Step 0a: Acquire the lock (shared with createDocExclusive — see tryAcquireLockOnce).
    const lockHeld = await tryAcquireLockOnce(lockPath);
    if (!lockHeld) continue;

    try {
      // Step 1: Read with resilience
      let current: Doc | null;
      try {
        current = await readDocWithRetry<Doc>(filePath);
      } catch (e) {
        // R4 — a JSON.parse SyntaxError is a recoverable "corrupted document" for a mutator that
        // ignores `current`; any other read failure (e.g. EISDIR) is not, and still bubbles as
        // corruptedError immediately regardless of the flag.
        if (mutatorIgnoresCurrent && e instanceof SyntaxError) {
          current = null;
        } else {
          return err(corruptedError);
        }
      }

      if (!current) {
        if (!mutatorIgnoresCurrent) return err(notFoundError);
        // R4 — mutate() below does not read `current` at all (it rebuilds the document from the
        // caller's own inputs), so a missing/corrupted current document is not fatal here. The
        // placeholder is never inspected; the raw bytes actually on disk (if any) still get
        // backed up by the unconditional rename in step 5.
        current = {} as Doc;
      }

      // Step 2: Apply mutation in memory
      const fnResult = mutate(current);
      if (!fnResult.ok) {
        // Logic error — do not retry
        return err(fnResult.error, fnResult.include_help ?? false);
      }

      // Step 3: Compute next backup name (we hold the lock, so the directory scan is stable)
      const bakPath = nextBackupPath(filePath);

      // Step 4: Set previous_version on the mutated document
      const toWrite = { ...fnResult.updated, previous_version: bakPath } as Doc;

      // Step 5: Move current file to backup. We hold the exclusive lock so renameSync
      // semantics are safe — bakPath cannot exist (we just computed max+1), and no other
      // writer is racing for filePath.
      try {
        fs.renameSync(filePath, bakPath); // FR-PLAN-0024 step 5 — guarded by lock
      } catch (renameErr) {
        // Should not happen inside the lock; if it does, surface and restart.
        logger.warn({ attempt, filePath, bakPath, error: String(renameErr) }, "rename failed under lock, restarting");
        continue;
      }

      // Step 6: Write new document content
      try {
        saveDoc(filePath, toWrite); // FR-PLAN-0026 — pretty-formatted on disk
      } catch (writeErr) {
        // Roll back: rename the bak back to file path.
        try { fs.renameSync(bakPath, filePath); } catch { /* best-effort */ }
        logger.warn({ attempt, filePath, bakPath, error: String(writeErr) }, "write failed after rename, rolled back, restarting");
        continue;
      }

      // Step 7: Prune oldest backups beyond retention
      pruneBackups(filePath, retention);

      logger.info({ filePath, bakPath, attempt }, "atomic write complete");
      return { ok: true, result: { result: fnResult.result, backupPath: bakPath }, error: null, include_help: false };
    } finally {
      if (lockHeld) {
        try { fs.rmdirSync(lockPath); } catch { /* best-effort */ }
      }
    }
  }

  // FR-PLAN-0024 — exhausted retries
  return err(ERR_BACKUP_CREATE_FAILED);
}
