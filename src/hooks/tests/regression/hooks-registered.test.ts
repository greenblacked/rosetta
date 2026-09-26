// hooks-registered.test.ts — Regression guard: every hook in src/ must be referenced
// in every plugin's hooks.json. If a hook is bundled but not registered, it is silently
// never invoked by the IDE.
//
// Release-aware: deterministic (advisory) hooks ship one-by-one from the designated hooks
// release (see shipsHooks / HOOKS_RELEASE). Below it the advisory hooks are intentionally
// absent, so the per-hook checks self-skip. At/above it the check is presence-based: a hook
// is validated only when its generated bundle is present in the plugin's hook folder, so a
// not-yet-released hook is silently skipped. The check is not disabled — it self-gates on
// the committed release and the committed artifacts.

import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { describe, test, expect } from 'vitest';
import { shipsHooks } from '../helpers/release';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const HOOKS_DIR = path.resolve(ROOT, 'src', 'hooks', 'src', 'hooks');
const PLUGINS_DIR = path.resolve(ROOT, 'plugins');

const CANONICAL_HOOKS_JSONS: { plugin: string; jsonPath: string; manifestPath: string }[] = [
  { plugin: 'core-claude',  jsonPath: path.join(PLUGINS_DIR, 'core-claude',  'hooks', 'hooks.json'), manifestPath: path.join(PLUGINS_DIR, 'core-claude',  '.claude-plugin', 'plugin.json') },
  { plugin: 'core-copilot', jsonPath: path.join(PLUGINS_DIR, 'core-copilot', 'hooks', 'hooks.json'), manifestPath: path.join(PLUGINS_DIR, 'core-copilot', '.github', 'plugin', 'plugin.json') },
  { plugin: 'core-cursor',  jsonPath: path.join(PLUGINS_DIR, 'core-cursor',  'hooks', 'hooks.json'), manifestPath: path.join(PLUGINS_DIR, 'core-cursor',  '.cursor-plugin', 'plugin.json') },
  { plugin: 'core-codex',   jsonPath: path.join(PLUGINS_DIR, 'core-codex',   '.codex', 'hooks.json'), manifestPath: path.join(PLUGINS_DIR, 'core-codex',   '.codex-plugin', 'plugin.json') },
];

// Hooks registered only on a subset of IDEs. Add entries here only for hooks using
// a platform-exclusive event unavailable on certain IDEs.
// Note: Cursor uses `preToolUse` (lowercase), Codex `PreToolUse` — both mapped in
// ide-registry.ts. Copilot infers PreToolUse from payload shape (registry entry is null
// but the event is processed). All current hooks are registered across every IDE.
const CLAUDE_CODE_ONLY_HOOKS: ReadonlySet<string> = new Set<string>();

const discoverHooks = (): string[] =>
  readdirSync(HOOKS_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => f.replace('.ts', ''));

describe('hooks-registered — bundled src hooks appear in every plugin hooks.json (from the hooks release)', () => {
  const hookNames = discoverHooks();

  test('at least one hook is discovered in src/', () => {
    expect(hookNames.length).toBeGreaterThan(0);
  });

  for (const { plugin, jsonPath, manifestPath } of CANONICAL_HOOKS_JSONS) {
    describe(`plugin: ${plugin}`, () => {
      let rawJson: string | null = null;
      try { rawJson = readFileSync(jsonPath, 'utf-8'); } catch { /* missing file */ }

      test(`hooks.json exists and is valid JSON`, () => {
        // Non-gated guard: holds for every release (r2 or r3+), so the committed
        // tree is always checked even when the advisory assertions below self-skip.
        expect(rawJson, `Missing: ${jsonPath}`).not.toBeNull();
        expect(() => JSON.parse(rawJson as string)).not.toThrow();
      });

      for (const hookName of hookNames) {
        // Skip claude-code-only hooks for non-claude plugins
        if (CLAUDE_CODE_ONLY_HOOKS.has(hookName) && plugin !== 'core-claude') continue;

        // E1: this guard is release-gated (advisory hooks ship one-by-one) and presence-based
        // (a hook is checked only once its bundle is actually generated into the plugin
        // folder). The committed tree ships with deterministicHooks:false, so NO bundle is
        // generated and every one of these was a silent `return` — 32 tests reporting green
        // while asserting nothing. `test.skipIf` makes that gap visible as SKIPPED instead.
        const bundlePath = path.join(path.dirname(jsonPath), `${hookName}.js`);
        const skip = !shipsHooks(manifestPath) || !rawJson || !existsSync(bundlePath);
        test.skipIf(skip)(`${hookName}.js is referenced`, () => {
          expect(rawJson).toContain(`${hookName}.js`);
        });
      }
    });
  }
});
