import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { UnsafeSymlinkError, unzipSource } from '../../src/curion/workspace';

/**
 * E3: `unzipSource` uses `extract-zip` (npm audit: high, GHSA-jmr9-qjv8-65gv —
 * unvalidated symlink path traversal). `extract-zip` itself blocks WRITES through an
 * escaping symlink, but still MATERIALIZES the symlink in the workspace. A later step
 * (an evaluator, `snapshotSource`/`computeDiff`, or the agent's own file tools) can
 * then follow it outside the sandbox. After extraction, `unzipSource` must walk the
 * workspace and reject/remove any symlink whose target escapes it — including a
 * dangling one, which cannot be verified as safe.
 */

const createdDirs: string[] = [];
afterAll(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/** Build a zip whose entries are populated by `fill(stageDir)`, storing any symlinks
 *  AS symlinks (Info-ZIP `-y`), the same as a case author's `zip` would. */
function buildZip(fill: (stage: string) => void): string {
  const stage = tmp('curio-e3-stage-');
  fill(stage);
  const zipDir = tmp('curio-e3-zip-');
  const zipPath = join(zipDir, 'src.zip');
  execFileSync('zip', ['-y', '-r', zipPath, '.'], { cwd: stage });
  return zipPath;
}

describe('E3: unzipSource rejects a src.zip that materializes an escaping symlink', () => {
  it('rejects a symlink whose target resolves outside the workspace, and removes it', async () => {
    const zipPath = buildZip((stage) => {
      symlinkSync('../outside', join(stage, 'link'));
    });
    const workspace = tmp('curio-e3-ws-');

    await expect(unzipSource(zipPath, workspace)).rejects.toThrow(UnsafeSymlinkError);
    // The escaping symlink must not survive in the workspace for a later step to follow.
    expect(readdirSync(workspace)).not.toContain('link');
  });

  it('rejects a dangling symlink the same way (its target cannot be verified as safe)', async () => {
    const zipPath = buildZip((stage) => {
      symlinkSync('/does/not/exist/curiocity-e3-probe', join(stage, 'dangling'));
    });
    const workspace = tmp('curio-e3-ws-');

    await expect(unzipSource(zipPath, workspace)).rejects.toThrow(UnsafeSymlinkError);
    expect(readdirSync(workspace)).not.toContain('dangling');
  });

  it('rejects a symlink nested inside a subdirectory, not just at the top level', async () => {
    const zipPath = buildZip((stage) => {
      execFileSync('mkdir', ['-p', join(stage, 'nested', 'dir')]);
      symlinkSync('../../../outside', join(stage, 'nested', 'dir', 'link'));
    });
    const workspace = tmp('curio-e3-ws-');

    await expect(unzipSource(zipPath, workspace)).rejects.toThrow(UnsafeSymlinkError);
    expect(readdirSync(join(workspace, 'nested', 'dir'))).not.toContain('link');
  });

  it('accepts an ordinary zip with no symlinks', async () => {
    const zipPath = buildZip((stage) => {
      writeFileSync(join(stage, 'ok.txt'), 'hello world');
    });
    const workspace = tmp('curio-e3-ws-');

    await expect(unzipSource(zipPath, workspace)).resolves.toBeUndefined();
    expect(existsSync(join(workspace, 'ok.txt'))).toBe(true);
  });

  it('accepts a symlink whose target stays inside the workspace', async () => {
    const zipPath = buildZip((stage) => {
      writeFileSync(join(stage, 'real.txt'), 'hello world');
      symlinkSync('real.txt', join(stage, 'alias.txt'));
    });
    const workspace = tmp('curio-e3-ws-');

    await expect(unzipSource(zipPath, workspace)).resolves.toBeUndefined();
    expect(readdirSync(workspace)).toContain('alias.txt');
  });

  // R10: `path.relative(root, target)` for an in-workspace target whose path segment
  // starts with two dots (e.g. a directory literally named `..shared`) yields a string
  // like `..shared/real.txt` — which starts with the two characters ".." but is NOT a
  // parent-escape (that would be `..` or `../real.txt`, i.e. ".." followed by a path
  // separator). The old `!rel.startsWith('..')` check conflated the two and wrongly
  // rejected this legitimate in-workspace symlink target.
  it('R10: accepts a symlink into an in-workspace "..shared" directory (name starting with ".." is not an escape)', async () => {
    const zipPath = buildZip((stage) => {
      execFileSync('mkdir', ['-p', join(stage, '..shared')]);
      writeFileSync(join(stage, '..shared', 'real.txt'), 'hello world');
      // Target string "..shared/real.txt" (no leading "../") resolves, relative to the
      // symlink's own directory (the stage root), to stage/..shared/real.txt — a
      // directory NAMED "..shared", not "go up one directory".
      symlinkSync('..shared/real.txt', join(stage, 'alias-into-dotdot-shared.txt'));
    });
    const workspace = tmp('curio-r10-ws-');

    await expect(unzipSource(zipPath, workspace)).resolves.toBeUndefined();
    expect(readdirSync(workspace)).toContain('alias-into-dotdot-shared.txt');
    expect(readdirSync(workspace)).toContain('..shared');
  });
});
