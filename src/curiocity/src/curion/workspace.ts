import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import extract from 'extract-zip';
import { execa } from 'execa';

/**
 * Trial workspace management (§7 steps 1, 6, 8). Every trial gets a fresh mkdtemp
 * workspace (D16); `src.zip` is unzipped in (stripping `__MACOSX`), or an inline
 * `--src` dir is copied. A snapshot of the unzipped source is kept so `collect`
 * can produce the workspace diff vs the ORIGINAL source (§5.4), i.e. before setup.
 */

export function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'curiocity-ws-'));
}

export function createCtrlDir(): string {
  return mkdtempSync(join(tmpdir(), 'curiocity-ctrl-'));
}

/**
 * (E3) Raised when an unzipped case's `src.zip` materializes a symlink that resolves
 * outside the workspace (or a dangling one that cannot be verified as safe). `extract-zip`
 * (GHSA-jmr9-qjv8-65gv) blocks WRITES through such a symlink but still creates the link
 * itself; a later step (evaluator, snapshot/diff) can then follow it out of the sandbox.
 * `lifecycle.ts` maps this to trial status `setup-error`.
 */
export class UnsafeSymlinkError extends Error {}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** (E3) Walk `workspace` and reject any symlink whose target escapes it — including a
 *  dangling link, which cannot be verified as safe. The escaping/dangling link is removed
 *  either way so it cannot be followed later (evaluators, snapshot/diff, agent tools). */
function rejectEscapingSymlinks(workspace: string): void {
  const realWorkspace = realpathSync(workspace);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        let real: string | null;
        try {
          real = realpathSync(full);
        } catch {
          real = null; // dangling — cannot verify, treat as unsafe
        }
        const safe = real !== null && isInside(realWorkspace, real);
        if (!safe) {
          rmSync(full, { force: true });
          throw new UnsafeSymlinkError(
            `Case source contains a symlink outside the workspace: "${relative(workspace, full)}"`,
          );
        }
        continue; // never follow into a symlinked directory
      }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(workspace);
}

/** Unzip `src.zip` into the workspace; strip the macOS `__MACOSX` sidecar (§7). */
export async function unzipSource(zipPath: string, workspace: string): Promise<void> {
  await extract(zipPath, { dir: workspace });
  const macosx = join(workspace, '__MACOSX');
  if (existsSync(macosx)) rmSync(macosx, { recursive: true, force: true });
  rejectEscapingSymlinks(workspace);
}

/** Copy an inline `--src <dir>` into the workspace. */
export function copySource(srcDir: string, workspace: string): void {
  cpSync(srcDir, workspace, { recursive: true });
}

/** Snapshot the current workspace to a sibling temp dir (baseline for the diff). */
export function snapshotSource(workspace: string): string {
  const snapshot = mkdtempSync(join(tmpdir(), 'curiocity-src-'));
  cpSync(workspace, snapshot, { recursive: true });
  return snapshot;
}

/**
 * Unified diff of `workspace` vs the unzipped-source `snapshot` (§5.4). Uses the
 * ubiquitous `diff -ruN` (exit code 1 = differences, not an error). Returns '' when
 * identical or when `diff` is unavailable.
 */
export async function computeDiff(snapshot: string, workspace: string): Promise<string> {
  try {
    const result = await execa('diff', ['-ruN', snapshot, workspace], { reject: false });
    return result.stdout ?? '';
  } catch {
    return '';
  }
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
