/**
 * Lint E2E — the r3 core instruction source must lint clean, standard and lightweight profile
 * alike (FR-CLI-0070–0074). Regression guard for the CI step in
 * .github/workflows/ci-rosettify-plugins.yml: if this ever goes red, that CI step goes red too.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { runLint } from '../../src/lint/lint.js';
import type { ResolvedSources } from '../../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function sources(): ResolvedSources {
  return {
    instructionsSource: path.join(REPO_ROOT, 'instructions'),
    pluginsSource: path.join(REPO_ROOT, 'src', 'rosettify-plugins', 'plugins'),
    hooksSource: path.join(REPO_ROOT, 'src', 'hooks'),
    outputDir: path.join(REPO_ROOT, 'plugins'),
    profileSource: path.join(REPO_ROOT, 'src', 'rosettify-plugins', 'profiles'),
  };
}

describe('lint — r3 core instruction source', () => {
  it('lints clean with no profile active', () => {
    const { findings } = runLint({ sources: sources(), release: 'r3', domain: 'core' });
    expect(findings).toEqual([]);
  });

  it('lints clean under the lightweight profile', () => {
    const { findings } = runLint({
      sources: sources(),
      release: 'r3',
      domain: 'core',
      profile: 'lightweight',
    });
    expect(findings).toEqual([]);
  });
});
