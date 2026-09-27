// FR-CLI-0070–0074 — deterministic instruction linter, over a small fixture instruction tree
// (tests/fixtures/lint-instructions/) covering each rule positive + negative, exit codes,
// allowlist, and placeholders.

import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { runLint, LintUsageError } from '../../../src/lint/lint.js';
import { formatFindingsJson, formatFindingsText, isLintFormat } from '../../../src/lint/format.js';
import type { ResolvedSources } from '../../../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', '..', 'fixtures');
const LINT_INSTRUCTIONS_SOURCE = path.join(FIXTURES_DIR, 'lint-instructions');
const LINT_PROFILE_SOURCE = path.join(FIXTURES_DIR, 'lint-profiles');

function sources(overrides: Partial<ResolvedSources> = {}): ResolvedSources {
  return {
    instructionsSource: LINT_INSTRUCTIONS_SOURCE,
    pluginsSource: path.join(FIXTURES_DIR, 'sample-plugins'),
    hooksSource: path.join(FIXTURES_DIR, 'sample-plugins'),
    outputDir: path.join(FIXTURES_DIR, 'lint-output-unused'),
    profileSource: LINT_PROFILE_SOURCE,
    ...overrides,
  };
}

function findingsFor(rule: string, result: ReturnType<typeof runLint>) {
  return result.findings.filter((f) => f.rule === rule);
}

describe('runLint — alias-target-exists', () => {
  const result = runLint({ sources: sources(), release: 'r3', domain: 'core' });
  const findings = findingsFor('alias-target-exists', result);

  it('reports a broken USE SKILL reference', () => {
    expect(findings.some((f) => f.file === 'skills/broken-skill/SKILL.md' && f.message.includes('does-not-exist'))).toBe(true);
  });

  it('reports a broken READ SKILL FILE reference', () => {
    expect(findings.some((f) => f.file === 'skills/broken-skill/SKILL.md' && f.message.includes('assets/missing.md'))).toBe(true);
  });

  it('reports a broken APPLY PHASE reference', () => {
    expect(findings.some((f) => f.file === 'workflows/flow-a.md' && f.message.includes('flow-a-phase-missing.md'))).toBe(true);
  });

  it('does not report a resolving USE SKILL reference', () => {
    expect(findings.some((f) => f.file === 'skills/good-skill/SKILL.md' && f.message.includes('`other-skill`'))).toBe(false);
  });

  it('does not report a resolving READ SKILL FILE reference', () => {
    expect(findings.some((f) => f.file === 'skills/broken-skill/SKILL.md' && f.message.includes('assets/exists.md'))).toBe(false);
  });

  it('does not report a resolving APPLY PHASE reference', () => {
    expect(findings.some((f) => f.file === 'workflows/flow-a.md' && f.message.includes('`flow-a-phase1.md`'))).toBe(false);
  });

  it('does not report an allowlisted external skill (graphify)', () => {
    expect(findings.some((f) => f.message.includes('graphify'))).toBe(false);
  });

  it('does not report an obvious placeholder target', () => {
    expect(findings.some((f) => f.message.includes('<name>'))).toBe(false);
  });

  it('excludes README.md from alias-target scanning', () => {
    expect(findings.some((f) => f.file.endsWith('README.md'))).toBe(false);
  });

  it('finds exactly the three broken references in the fixture tree', () => {
    expect(findings).toHaveLength(3);
  });
});

describe('runLint — unique-document-name / name-matches-filename', () => {
  const result = runLint({ sources: sources(), release: 'r3', domain: 'core' });
  const uniqueFindings = findingsFor('unique-document-name', result);
  const matchFindings = findingsFor('name-matches-filename', result);

  it('reports a name collision between two workflows', () => {
    expect(uniqueFindings.some((f) => f.file === 'workflows/flow-a.md')).toBe(true);
    expect(uniqueFindings.some((f) => f.file === 'workflows/dup-flow.md')).toBe(true);
  });

  it('does not report a collision for an unambiguous name', () => {
    expect(uniqueFindings.some((f) => f.file === 'skills/good-skill/SKILL.md')).toBe(false);
  });

  it('reports an agent whose frontmatter name does not match its filename', () => {
    expect(matchFindings.some((f) => f.file === 'agents/mismatched.md')).toBe(true);
  });

  it('does not report a matching agent name', () => {
    expect(matchFindings.some((f) => f.file === 'agents/alpha.md')).toBe(false);
  });

  it('does not check rule files for name/filename match (out of this rule\'s scope)', () => {
    expect(matchFindings.some((f) => f.file === 'rules/renamed-rule.md')).toBe(false);
  });

  it('does not flag the lightweight agent twin against its base counterpart with no profile active', () => {
    // With no profile active, the twin is excluded entirely by resolveLintFiles (matchesProfile),
    // so only agents/alpha.md is visible and there is exactly one "alpha".
    expect(uniqueFindings.some((f) => f.message.includes('"alpha"'))).toBe(false);
  });
});

describe('runLint — known-model-token', () => {
  const result = runLint({ sources: sources(), release: 'r3', domain: 'core' });
  const findings = findingsFor('known-model-token', result);

  it('reports an invented vendor token', () => {
    expect(findings.some((f) => f.file === 'agents/bad-model.md' && f.message.includes('made-up-vendor-9000'))).toBe(true);
  });

  it('does not report recognized vendor tokens', () => {
    expect(findings.some((f) => f.file === 'agents/alpha.md')).toBe(false);
  });

  it('reports a profile-only-known token when no profile is active', () => {
    expect(findings.some((f) => f.file === 'agents/profiled-model.md' && f.message.includes('widget-9'))).toBe(true);
  });
});

describe('runLint — profile resolution', () => {
  it('excludes the base agent and keeps the lightweight twin under --profile lightweight', () => {
    const result = runLint({
      sources: sources(),
      release: 'r3',
      domain: 'core',
      profile: 'lightweight',
    });
    const uniqueFindings = findingsFor('unique-document-name', result);
    expect(uniqueFindings.some((f) => f.message.includes('"alpha"'))).toBe(false);
    // The lightweight twin's own tokens (gpt-5.6-luna-medium, claude-haiku-4-5) are recognized.
    const modelFindings = findingsFor('known-model-token', result);
    expect(modelFindings.some((f) => f.file === 'agents/alpha.md')).toBe(false);
  });

  it('recognizes a profile-scoped modelOverrides token under --profile custom', () => {
    const result = runLint({ sources: sources(), release: 'r3', domain: 'core', profile: 'custom' });
    const findings = findingsFor('known-model-token', result);
    expect(findings.some((f) => f.file === 'agents/profiled-model.md')).toBe(false);
  });

  it('still flags widget-9 as unknown with no profile active', () => {
    const result = runLint({ sources: sources(), release: 'r3', domain: 'core' });
    const findings = findingsFor('known-model-token', result);
    expect(findings.some((f) => f.file === 'agents/profiled-model.md' && f.message.includes('widget-9'))).toBe(true);
  });
});

describe('runLint — usage errors (FR-CLI-0070.AC3)', () => {
  it('throws LintUsageError for an unknown release', () => {
    expect(() => runLint({ sources: sources(), release: 'r9', domain: 'core' })).toThrow(LintUsageError);
  });

  it('throws LintUsageError for an unresolvable domain', () => {
    expect(() => runLint({ sources: sources(), release: 'r3', domain: 'does-not-exist' })).toThrow(LintUsageError);
  });

  it('throws LintUsageError for a profile whose descriptor cannot be loaded', () => {
    expect(() =>
      runLint({ sources: sources(), release: 'r3', domain: 'core', profile: 'does-not-exist' }),
    ).toThrow(LintUsageError);
  });
});

describe('lint output formats', () => {
  const result = runLint({ sources: sources(), release: 'r3', domain: 'core' });

  it('formats findings as one "file:line: [rule] message" line each', () => {
    const text = formatFindingsText(result.findings);
    for (const f of result.findings) {
      expect(text).toContain(`${f.file}:${f.line}: [${f.rule}] ${f.message}`);
    }
  });

  it('formats findings as a parseable JSON array with the same content', () => {
    const json = formatFindingsJson(result.findings);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(result.findings);
  });

  it('formats zero findings as an empty text string and an empty JSON array', () => {
    expect(formatFindingsText([])).toBe('');
    expect(JSON.parse(formatFindingsJson([]))).toEqual([]);
  });

  it('recognizes exactly "text" and "json" as valid lint formats', () => {
    expect(isLintFormat('text')).toBe(true);
    expect(isLintFormat('json')).toBe(true);
    expect(isLintFormat('xml')).toBe(false);
  });
});

describe('runLint — clean fixture subset has zero findings', () => {
  it('the two positive-only files (good-skill, other-skill) produce no findings about themselves', () => {
    const result = runLint({ sources: sources(), release: 'r3', domain: 'core' });
    const own = result.findings.filter(
      (f) => f.file === 'skills/good-skill/SKILL.md' || f.file === 'skills/other-skill/SKILL.md',
    );
    expect(own).toEqual([]);
  });
});
