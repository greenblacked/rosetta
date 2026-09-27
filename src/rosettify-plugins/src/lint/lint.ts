// FR-CLI-0070 — lint mode orchestration: resolve the instruction source through the generator's
// existing VFS/file-loading path, then run every rule against it. Writes nothing.

import { buildVfs } from '../vfs/build-vfs.js';
import { getRelease, listReleases } from '../spec/releases.js';
import { loadProfile, type ProfileDescriptor } from '../spec/profiles.js';
import type { ResolvedSources, Vfs } from '../types.js';
import { resolveLintFiles } from './resolve.js';
import { aliasTargetExistsRule } from './rules/alias-targets.js';
import { nameConsistencyRule } from './rules/name-consistency.js';
import { knownModelTokenRule } from './rules/model-tokens.js';
import type { Finding } from './types.js';

/**
 * Thrown for any lint-mode usage error (FR-CLI-0070.AC3): unknown release, unresolvable domain, or
 * a `--profile` whose descriptor cannot be loaded. The CLI maps this to exit status 2, distinct
 * from "ran cleanly and found problems" (exit 1) and "ran cleanly and found nothing" (exit 0).
 */
export class LintUsageError extends Error {}

export interface LintOptions {
  sources: ResolvedSources;
  release: string;
  domain: string;
  profile?: string;
}

export interface LintResult {
  findings: Finding[];
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}

/**
 * Runs every lint rule against the resolved instruction source for `options.release`/
 * `options.domain`/`options.profile` and returns the findings. Never writes to disk.
 */
export function runLint(options: LintOptions): LintResult {
  const { sources, release: releaseName, domain, profile: profileName } = options;

  if (!getRelease(releaseName)) {
    throw new LintUsageError(
      `Unknown release: "${releaseName}". Known releases: ${listReleases().join(', ')}`,
    );
  }

  let profile: ProfileDescriptor | null = null;
  if (profileName !== undefined) {
    try {
      profile = loadProfile(sources.profileSource, profileName);
    } catch (err) {
      throw new LintUsageError(`Failed to load profile: ${(err as Error).message}`);
    }
  }

  let vfs: Vfs;
  try {
    vfs = buildVfs(sources.instructionsSource, releaseName, domain);
  } catch (err) {
    throw new LintUsageError(`Failed to resolve instruction sources: ${(err as Error).message}`);
  }

  const files = resolveLintFiles(vfs, profileName ?? null);

  const findings: Finding[] = [
    ...aliasTargetExistsRule(files),
    ...nameConsistencyRule(files),
    ...knownModelTokenRule(files, profile),
  ];

  return { findings: sortFindings(findings) };
}
