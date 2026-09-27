// claude-plugin-root.test.ts — Smoke test for CLAUDE_PLUGIN_ROOT env-var resolution.
//
// CLAUDE_PLUGIN_ROOT is injected by Claude Code at hook execution time and points to
// the installed plugin directory. If it is missing or unresolved, the hook command
// expands to an invalid path and silently does nothing.
//
// These tests verify:
// 1. The built loose-files.js is present at the expected CLAUDE_PLUGIN_ROOT-relative path.
// 2. When the env var is set correctly, the script executes and produces valid JSON.
// 3. The hooks.json for core-claude references ${CLAUDE_PLUGIN_ROOT} in PostToolUse.

import { test, describe, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { shipsHooks } from './helpers/release';

const HOOKS_ROOT = path.resolve(__dirname, '..');

// Path that CLAUDE_PLUGIN_ROOT would point to in a real Claude Code install.
// In tests we point it at the project-local copy of the built plugin.
const PLUGIN_ROOT = path.resolve(HOOKS_ROOT, '..', '..', 'plugins', 'core-claude');
const LOOSE_FILES_JS = path.join(PLUGIN_ROOT, 'hooks', 'loose-files.js');

// Release detection: deterministic (advisory) hooks ship one-by-one from the designated
// hooks release onward. Below it the advisory hooks are intentionally absent; at/above it
// these checks additionally gate on the presence of the loose-files bundle (presence-based),
// so they only report once loose-files is actually released.
const MANIFEST = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const SHIPS_HOOKS = shipsHooks(MANIFEST);

// ---------------------------------------------------------------------------
describe('CLAUDE_PLUGIN_ROOT — file exists at expected path', () => {

  // E1: both conditions are known before the test runs; a silent `return` inside the test body
  // reported green while asserting nothing whenever the committed tree ships without advisory
  // hooks (deterministicHooks:false, the shipped default) or before loose-files.js is registered.
  const hooksJsonForShip = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
  const rawForShip = existsSync(hooksJsonForShip) ? readFileSync(hooksJsonForShip, 'utf-8') : '';
  const looseFilesRegistered = rawForShip.includes('loose-files.js');

  test.skipIf(!SHIPS_HOOKS || !looseFilesRegistered)(
    'plugins/core-claude/hooks/loose-files.js is present when registered', () => {
      // Registered in hooks.json ⇒ its bundle must be shipped, else the command silently no-ops.
      expect(existsSync(LOOSE_FILES_JS), `Missing: ${LOOSE_FILES_JS}`).toBe(true);
    });

});

// ---------------------------------------------------------------------------
describe('CLAUDE_PLUGIN_ROOT — hooks.json references the env var', () => {

  const hooksJsonPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');

  test('hooks.json exists', () => {
    expect(existsSync(hooksJsonPath)).toBe(true);
  });

  // E1: `test.skipIf` in place of a silent `return` — the committed tree ships without
  // advisory hooks (deterministicHooks:false), so these were 2 of the vacuous tests.
  test.skipIf(!existsSync(LOOSE_FILES_JS))(
    'PostToolUse command uses ${CLAUDE_PLUGIN_ROOT}', () => {
      const raw = readFileSync(hooksJsonPath, 'utf-8');
      expect(raw).toContain('${CLAUDE_PLUGIN_ROOT}');
    });

  test.skipIf(!existsSync(LOOSE_FILES_JS))(
    '${CLAUDE_PLUGIN_ROOT} path ends with /hooks/loose-files.js', () => {
      const raw = readFileSync(hooksJsonPath, 'utf-8');
      expect(raw).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/loose-files.js');
    });

});

// ---------------------------------------------------------------------------
describe('CLAUDE_PLUGIN_ROOT — script executes correctly when env var is set', () => {

  const CC_INPUT = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'smoke-test-session',
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/rosetta-smoke-test-orphan.py', content: 'pass\n' },
    tool_use_id: 'smoke-tu-001',
    cwd: '/tmp',
    permission_mode: 'default',
  });

  // E1: `test.skipIf` in place of a silent `return` for the remaining vacuous tests in this
  // file — the committed tree ships without advisory hooks (deterministicHooks:false).
  test.skipIf(!existsSync(LOOSE_FILES_JS))('exits 0 when CLAUDE_PLUGIN_ROOT is valid', () => {
    const result = spawnSync('node', [LOOSE_FILES_JS], {
      input: CC_INPUT,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: 'utf-8',
    });
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  });

  test.skipIf(!existsSync(LOOSE_FILES_JS))('produces valid JSON output for a loose .py file', () => {
    const result = spawnSync('node', [LOOSE_FILES_JS], {
      input: CC_INPUT,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    const out = (result.stdout ?? '').trim();
    if (!out) return; // file may not be loose if /tmp has a package.json
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined;
    expect(hso?.additionalContext).toBeTruthy();
  });

  test.skipIf(!existsSync(LOOSE_FILES_JS))('exits 0 silently for non-JS/PY file (no output expected)', () => {
    const tsInput = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'smoke-test-session',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/rosetta-smoke.ts', content: 'x\n' },
      tool_use_id: 'smoke-tu-002',
      cwd: '/tmp',
      permission_mode: 'default',
    });
    const result = spawnSync('node', [LOOSE_FILES_JS], {
      input: tsInput,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect((result.stdout ?? '').trim()).toBe('');
  });

});
