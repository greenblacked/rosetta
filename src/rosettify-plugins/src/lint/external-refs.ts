// FR-CLI-0071 — documented allowlist for typed-reference targets that intentionally resolve
// outside this instruction source tree (a tool or skill the instructions assume is installed
// separately in the target repository). Extend this list, with a one-line reason, whenever a new
// external reference is intentionally introduced. Never add an entry to silence a real dangling
// reference — a rename or removal inside `instructions/<release>/<domain>/` must be fixed at the
// source, not allowlisted here.

export type AliasKind =
  | 'SKILL'
  | 'SUBAGENT'
  | 'FLOW'
  | 'PHASE'
  | 'RULE'
  | 'TEMPLATE'
  | 'CONFIGURE'
  | 'SKILL FILE';

export interface ExternalRefAllowEntry {
  kind: AliasKind;
  name: string;
  reason: string;
}

export const EXTERNAL_REF_ALLOWLIST: readonly ExternalRefAllowEntry[] = [
  {
    kind: 'SKILL',
    name: 'graphify',
    reason:
      'External code-graph skill the codemap skill offers as an option; installed separately ' +
      'into the target repo (docs/ARCHITECTURE.md "Hooks Runtime" — codemap-refresh detects ' +
      'graphify-out/graph.json), not part of this instruction source tree.',
  },
];

export function isAllowlistedExternalRef(kind: AliasKind, name: string): boolean {
  return EXTERNAL_REF_ALLOWLIST.some((e) => e.kind === kind && e.name === name);
}
