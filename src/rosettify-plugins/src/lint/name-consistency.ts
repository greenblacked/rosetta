// FR-CLI-0072 — shared name/filename-stem consistency logic. This is the SAME computation used by
// tests/unit/spec/frontmatter-name-consistency.test.ts (the C3 regression test): both import this
// function rather than each re-deriving "clean filename stem" from parseDirectives().

import { parseDirectives } from '../vfs/directives.js';

/**
 * Expected frontmatter `name` for a workflow/phase/agent/rule source file, derived from its own
 * clean filename stem (directive tokens and `.md` extension stripped). Skills are compared
 * against their own directory name instead (see callers) since a skill's identity is its folder,
 * not `SKILL.md` itself.
 */
export function expectedNameStemFromFilename(filename: string): string {
  const { cleanName } = parseDirectives(filename);
  return cleanName.replace(/\.md$/, '');
}
