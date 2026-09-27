// FR-CLI-0072 — unique-document-name + name-matches-filename rules, evaluated over the ALREADY
// profile/overwrite-resolved LintFile list (src/lint/resolve.ts) so a `<agent>~profile-lightweight-
// only~overwrite~.md` twin never collides with the base file it replaces in that resolved view.

import { expectedNameStemFromFilename } from '../name-consistency.js';
import type { Finding, LintFile } from '../types.js';

const UNIQUE_RULE = 'unique-document-name';
const MATCH_RULE = 'name-matches-filename';

type InstructionType = 'skill' | 'agent' | 'workflow' | 'rule';

// name-matches-filename reuses exactly the scope of tests/unit/spec/frontmatter-name-consistency.test.ts
// (skills, agents, workflows) — rules are not covered by that test and are excluded here too, so this
// rule stays byte-for-byte the same check that test already makes, just over the resolved VFS instead
// of the raw disk tree. Uniqueness, below, still covers all four types: "unique per instruction type"
// is not scoped down the same way.
const NAME_MATCH_TYPES: ReadonlySet<InstructionType> = new Set(['skill', 'agent', 'workflow']);

interface TypedFile {
  type: InstructionType;
  /** Expected frontmatter `name`: filename stem, or (skill) the skill directory name. */
  expectedName: string;
  file: LintFile;
  name: string;
}

function frontmatterName(file: LintFile): string | undefined {
  const name = file.frontmatter?.name;
  return typeof name === 'string' ? name : undefined;
}

function classify(files: LintFile[]): TypedFile[] {
  const typed: TypedFile[] = [];

  for (const file of files) {
    const name = frontmatterName(file);
    if (name === undefined) continue;

    const segs = file.path.split('/');
    if (segs[0] === 'skills' && segs.length >= 2 && segs[segs.length - 1] === 'SKILL.md') {
      typed.push({ type: 'skill', expectedName: segs[1], file, name });
    } else if (segs[0] === 'agents' && file.path.endsWith('.md')) {
      typed.push({ type: 'agent', expectedName: expectedNameStemFromFilename(segs[segs.length - 1]), file, name });
    } else if (segs[0] === 'workflows' && file.path.endsWith('.md')) {
      typed.push({ type: 'workflow', expectedName: expectedNameStemFromFilename(segs[segs.length - 1]), file, name });
    } else if (segs[0] === 'rules' && file.path.endsWith('.md')) {
      typed.push({ type: 'rule', expectedName: expectedNameStemFromFilename(segs[segs.length - 1]), file, name });
    }
  }

  return typed;
}

function firstLineOfName(file: LintFile): number {
  const idx = file.content.split('\n').findIndex((l) => /^name:\s*/.test(l));
  return idx >= 0 ? idx + 1 : 1;
}

/**
 * FR-CLI-0072: frontmatter `name` unique per instruction type, and matching the file's own
 * filename stem (workflows/phases/agents/rules) or directory name (skills).
 */
export function nameConsistencyRule(files: LintFile[]): Finding[] {
  const findings: Finding[] = [];
  const typed = classify(files);

  // name-matches-filename (skills/agents/workflows only — see NAME_MATCH_TYPES)
  for (const t of typed) {
    if (!NAME_MATCH_TYPES.has(t.type)) continue;
    if (t.name !== t.expectedName) {
      findings.push({
        rule: MATCH_RULE,
        severity: 'error',
        file: t.file.path,
        line: firstLineOfName(t.file),
        message:
          t.type === 'skill'
            ? `SKILL.md frontmatter name "${t.name}" does not match its own skill directory name "${t.expectedName}".`
            : `frontmatter name "${t.name}" does not match its own filename stem "${t.expectedName}".`,
      });
    }
  }

  // unique-document-name, per type
  const byType = new Map<InstructionType, Map<string, TypedFile[]>>();
  for (const t of typed) {
    const byName = byType.get(t.type) ?? new Map<string, TypedFile[]>();
    const group = byName.get(t.name) ?? [];
    group.push(t);
    byName.set(t.name, group);
    byType.set(t.type, byName);
  }

  for (const byName of byType.values()) {
    for (const [name, group] of byName) {
      if (group.length <= 1) continue;
      const paths = group.map((g) => g.file.path).join(', ');
      for (const t of group) {
        findings.push({
          rule: UNIQUE_RULE,
          severity: 'error',
          file: t.file.path,
          line: firstLineOfName(t.file),
          message: `frontmatter name "${name}" is used by more than one ${t.type} in this resolved build: ${paths}.`,
        });
      }
    }
  }

  return findings;
}
