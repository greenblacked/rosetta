// FR-CLI-0070 — resolve the VFS into the LintFile list a real build would see for one
// release/domain/profile, reusing the generator's existing file-loading path (fileRead/fileBundle,
// FR-ARCH-0040/0042) rather than a second, parallel content parser.
//
// Deliberately different from fileApplyOverrides (file-processors/file-apply-overrides.ts): that
// function ALSO drops SourceFiles by `<target>-only` directive, because a real build picks one IDE
// target. Lint is IDE-agnostic — a typed alias resolves the same way regardless of which plugin
// eventually consumes it — so only the profile-only/overwrite half of that logic applies here
// (matchesProfile + the overwrite-drop rule, both imported from vfs/directives.ts, never
// reimplemented). A `<target>-only` file is still linted; it simply isn't excluded for not
// matching some particular target.

import { createFileFrame } from '../frames.js';
import { fileBundle } from '../file-processors/file-bundle.js';
import { fileRead } from '../file-processors/file-read.js';
import { matchesProfile } from '../vfs/directives.js';
import type { SourceFile, TargetContext, VirtualFile, Vfs } from '../types.js';
import type { LintFile } from './types.js';

/**
 * Select the SourceFiles that apply for `activeProfile`, applying the same
 * profile-only-exclusion + overwrite-drop rules fileApplyOverrides uses (FR-PROF-0030,
 * FR-ARCH-0024), without the target-only filtering step (see module doc above).
 */
export function selectSourcesForProfile(
  sourceFiles: readonly SourceFile[],
  activeProfile: string | null,
): SourceFile[] {
  const profileFiltered = sourceFiles.filter((sf) => matchesProfile(sf.conditions, activeProfile));
  const overwriteIdx = profileFiltered.findIndex((sf) => sf.conditions.has('overwrite'));
  return overwriteIdx > 0 ? profileFiltered.slice(overwriteIdx) : profileFiltered;
}

// fileRead/fileBundle read TargetContext but neither actually branches on its fields; lint has no
// PluginSpec/ReleaseDescriptor to hand them, so an empty stand-in is passed through unused.
const NOOP_CONTEXT = {} as TargetContext;

/**
 * Resolve every VirtualFile in `vfs` into a LintFile for the given active profile (or null = no
 * profile), dropping any file excluded entirely for this profile. Binary files are skipped: lint
 * only inspects markdown/text instruction content.
 */
export function resolveLintFiles(vfs: Vfs, activeProfile: string | null): LintFile[] {
  const files: LintFile[] = [];

  for (const vf of vfs) {
    const selected = selectSourcesForProfile(vf.sourceFiles, activeProfile);
    if (selected.length === 0) continue;

    const asVf: VirtualFile = { path: vf.path, sourceFiles: selected };
    let frame = createFileFrame(asVf, vf.path);
    frame = fileRead(frame, NOOP_CONTEXT);
    frame = fileBundle(frame, NOOP_CONTEXT);

    if (frame.isBinary || typeof frame.target_contents !== 'string') continue;

    files.push({
      path: vf.path,
      origin: selected[selected.length - 1].origin,
      content: frame.target_contents,
      frontmatter: frame.source[0]?.frontmatter,
    });
  }

  return files;
}
