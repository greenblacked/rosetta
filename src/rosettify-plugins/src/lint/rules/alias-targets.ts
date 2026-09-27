// FR-CLI-0071 — alias-target-exists rule: every typed command-alias reference must resolve to an
// instruction file present in the resolved VFS (docs/ARCHITECTURE.md "Command Aliases").

import { parseFrontmatter } from '../../serialize/frontmatter.js';
import { isAllowlistedExternalRef, type AliasKind } from '../external-refs.js';
import type { Finding, LintFile } from '../types.js';

const RULE = 'alias-target-exists';

// Matches both the documented `` `target` `` form and a bare (non-backtick) target, since real
// instructions use both (e.g. "USE SKILL `graphify`" and "USE SKILL research"). `<`/`>` are
// included in the character class so a placeholder like `<vendor>-format.md` is captured whole
// (and then recognized as a placeholder below) rather than truncated at the `<`.
const ALIAS_PATTERN =
  /\b(USE|READ|APPLY|INVOKE)\s+(SKILL FILE|SKILL|FLOW|PHASE|SUBAGENT|RULE|TEMPLATE|CONFIGURE)\s+`?([A-Za-z0-9_./<>-]+)`?/g;

// Connective/prose words the alias verbs are followed by in ordinary sentences ("READ SKILL FILE
// line still hardcodes...", "APPLY PHASE the next step..."). A real target is always a filename or
// bare identifier and never collides with these; verified against the full r3 core corpus.
const PROSE_STOPWORDS = new Set([
  'to', 'the', 'a', 'from', 'and', 'or', 'with', 'as', 'per', 'in', 'that',
  'for', 'it', 'this', 'files', 'file', 'at', 'its', 'line', 'row', 'still',
]);

function isPlaceholderOrProse(target: string): boolean {
  if (target.includes('<') || target.includes('>')) return true;
  if (PROSE_STOPWORDS.has(target)) return true;
  // An ALL-CAPS token is grammar/emphasis text (e.g. a string meant to be written into the target
  // repo's own docs), never a real skill/agent/file identifier — those are lowercase-dash-separated
  // by the naming convention in docs/ARCHITECTURE.md "Instruction Structure".
  if (/^[A-Z0-9_]+$/.test(target)) return true;
  return false;
}

function withMdExt(target: string): string {
  return target.endsWith('.md') ? target : `${target}.md`;
}

interface Lookups {
  byPath: Set<string>;
  basenames: Set<string>;
  skillDirs: Set<string>;
  agentNames: Set<string>;
  workflowBasenames: Set<string>;
  ruleBasenames: Set<string>;
}

function buildLookups(files: LintFile[]): Lookups {
  const byPath = new Set(files.map((f) => f.path));
  const basenames = new Set(files.map((f) => f.path.split('/').pop()!));
  const skillDirs = new Set(
    files.filter((f) => f.path.startsWith('skills/')).map((f) => f.path.split('/')[1]),
  );
  const agentNames = new Set(
    files
      .filter((f) => f.path.startsWith('agents/') && f.path.endsWith('.md'))
      .map((f) => f.path.slice('agents/'.length).replace(/\.md$/, '')),
  );
  const workflowBasenames = new Set(
    files
      .filter((f) => f.path.startsWith('workflows/') && f.path.endsWith('.md'))
      .map((f) => f.path.split('/').pop()!),
  );
  const ruleBasenames = new Set(
    files
      .filter((f) => f.path.startsWith('rules/') && f.path.endsWith('.md'))
      .map((f) => f.path.split('/').pop()!),
  );
  return { byPath, basenames, skillDirs, agentNames, workflowBasenames, ruleBasenames };
}

function resolveTarget(kind: AliasKind, target: string, filePath: string, lu: Lookups): boolean {
  switch (kind) {
    case 'SKILL':
      return lu.skillDirs.has(target);
    case 'SUBAGENT':
      return lu.agentNames.has(target);
    case 'FLOW':
    case 'PHASE': {
      const t = withMdExt(target);
      return lu.workflowBasenames.has(t) || lu.basenames.has(t);
    }
    case 'RULE': {
      const t = withMdExt(target);
      return lu.ruleBasenames.has(t) || lu.basenames.has(t);
    }
    case 'TEMPLATE':
    case 'CONFIGURE': {
      const b = withMdExt(target).split('/').pop()!;
      return lu.basenames.has(b);
    }
    case 'SKILL FILE': {
      const segs = filePath.split('/');
      const skillIdx = segs.indexOf('skills');
      if (skillIdx >= 0 && segs.length > skillIdx + 1) {
        const skillRoot = segs.slice(0, skillIdx + 2).join('/');
        return lu.byPath.has(`${skillRoot}/${target}`);
      }
      return lu.basenames.has(target.split('/').pop()!);
    }
    default:
      return true;
  }
}

/**
 * FR-CLI-0071: every typed alias reference resolves, except an allowlisted external reference or
 * an obvious placeholder. `README.md` is excluded from scanning (FR-CLI-0071.AC4): it is a
 * maintainer document never loaded at runtime (docs/ARCHITECTURE.md "Instruction Structure").
 */
export function aliasTargetExistsRule(files: LintFile[]): Finding[] {
  const findings: Finding[] = [];
  const lookups = buildLookups(files);

  for (const file of files) {
    if (file.path.endsWith('README.md')) continue;

    // Scan the body only, never the YAML frontmatter block: a `description:` line is free-form
    // prose (e.g. "Phase file target of flow-a's APPLY PHASE reference") and can accidentally spell
    // an alias verb+kind pair with no real target following it; no instruction actually places a
    // typed alias inside frontmatter. lineOffset keeps reported line numbers 1-based against the
    // full file content.
    const { body } = parseFrontmatter(file.content);
    const frontmatterPrefix = file.content.slice(0, file.content.length - body.length);
    const lineOffset = (frontmatterPrefix.match(/\n/g) ?? []).length;

    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      ALIAS_PATTERN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ALIAS_PATTERN.exec(line)) !== null) {
        const [, verb, kindRaw, rawTarget] = m;
        const kind = kindRaw as AliasKind;
        const target = rawTarget.replace(/[.,:;)]+$/, '');
        if (target === '' || isPlaceholderOrProse(target)) continue;

        if (resolveTarget(kind, target, file.path, lookups)) continue;
        if (isAllowlistedExternalRef(kind, target)) continue;

        findings.push({
          rule: RULE,
          severity: 'error',
          file: file.path,
          line: lineOffset + i + 1,
          message: `${verb} ${kind} \`${target}\` does not resolve to any instruction file for this release/profile.`,
        });
      }
    }
  }

  return findings;
}
