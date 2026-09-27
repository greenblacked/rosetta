/**
 * SessionStart matcher regression (D1): `docs/hooks/claude-code.md` and `docs/hooks/codex.md` both
 * verify (R1) that the SessionStart event fires for FOUR sources — `startup`, `resume`, `clear`,
 * `compact` — not `startup` alone. A plugin whose matcher names only `startup` silently loses the
 * bootstrap (guardrails, HITL policy, plugin-mode routing) after any `/clear` or compaction.
 *
 * Claude: matcher is `startup|clear|compact` (no `resume` — open question for maintainers, see
 * FINAL.md). Codex: matcher is `startup|resume|clear|compact` (the repo's own hook contract proves
 * Codex supports all four).
 *
 * Entries must also carry no `"once"` field on Claude: `once` applies to skill/agent hooks only
 * (docs/hooks/claude-code.md), and on a SessionStart entry it would suppress re-injection on the
 * second and later `clear`/`compact` events in one session.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { generate } from '../../src/index.js';
import type { ResolvedSources } from '../../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function buildSources(outputDir: string): ResolvedSources {
  return {
    instructionsSource: path.join(REPO_ROOT, 'instructions'),
    pluginsSource: path.join(REPO_ROOT, 'src', 'rosettify-plugins', 'plugins'),
    hooksSource: path.join(REPO_ROOT, 'src', 'hooks'),
    outputDir,
  };
}

describe('SessionStart matcher covers clear/compact (D1)', () => {
  let tmp: string;
  let outputDir: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstart-matcher-'));
    outputDir = path.join(tmp, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    await generate({
      sources: buildSources(outputDir),
      release: 'r3',
      domain: 'core',
      dryRun: false,
      verbose: false,
      deterministicHooks: false,
    });
  }, 60000);

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('core-claude hooks.json SessionStart matcher is "startup|clear|compact" with no "once" entries', () => {
    const raw = fs.readFileSync(
      path.join(outputDir, 'core-claude', 'hooks', 'hooks.json'), 'utf-8');
    const data = JSON.parse(raw);
    expect(data.hooks.SessionStart[0].matcher).toBe('startup|clear|compact');
    expect(raw).not.toContain('"once"');
  });

  it('core-codex hooks.json SessionStart matcher is "startup|resume|clear|compact"', () => {
    const data = JSON.parse(fs.readFileSync(
      path.join(outputDir, 'core-codex', '.codex-plugin', 'hooks.json'), 'utf-8'));
    expect(data.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
  });
});
