import { describe, test, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getEffectivePatternSets,
  resolveManagedPolicyPath,
  resolveProjectPolicyPath,
} from '../../src/runtime/policy';
import { DANGEROUS_BASH } from '../../src/hooks/dangerous-actions/patterns';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));

const freshDir = (label: string): string => {
  const dir = path.join(TMP, `${label}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const writeManaged = (dir: string, json: unknown): string => {
  const p = path.join(dir, 'managed-policy.json');
  fs.writeFileSync(p, typeof json === 'string' ? json : JSON.stringify(json));
  return p;
};

const writeProject = (repoRoot: string, json: unknown): void => {
  const rosettaDir = path.join(repoRoot, '.rosetta');
  fs.mkdirSync(rosettaDir, { recursive: true });
  fs.writeFileSync(path.join(rosettaDir, 'policy.json'), typeof json === 'string' ? json : JSON.stringify(json));
};

const noManaged = (dir: string): Record<string, string> => ({ ROSETTA_POLICY_FILE: path.join(dir, 'does-not-exist.json') });

describe('resolveManagedPolicyPath', () => {
  test('uses ROSETTA_POLICY_FILE when set', () => {
    expect(resolveManagedPolicyPath({ ROSETTA_POLICY_FILE: '/custom/policy.json' })).toBe('/custom/policy.json');
  });
  test('falls back to the platform default when unset', () => {
    const p = resolveManagedPolicyPath({});
    expect(p.length).toBeGreaterThan(0);
  });
});

describe('resolveProjectPolicyPath', () => {
  test('resolves to <repo-root>/.rosetta/policy.json when a .git marker is found', () => {
    const repoRoot = freshDir('repo');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    const nested = path.join(repoRoot, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveProjectPolicyPath(nested)).toBe(path.join(repoRoot, '.rosetta', 'policy.json'));
  });
  test('falls back to cwd itself when no .git marker is found', () => {
    const dir = freshDir('no-git');
    expect(resolveProjectPolicyPath(dir)).toBe(path.join(dir, '.rosetta', 'policy.json'));
  });
});

describe('missing files — identical to no policy configured', () => {
  test('no managed file, no project file → pure built-ins', () => {
    const cwd = freshDir('missing-both');
    const sets = getEffectivePatternSets(cwd, noManaged(cwd));
    expect(sets.bash.length).toBe(DANGEROUS_BASH.length);
    expect(sets.bash.every((p) => p.source === 'builtin')).toBe(true);
  });
});

describe('managed policy — patterns.add', () => {
  test('adds a new bash pattern at the requested tier', () => {
    const cwd = freshDir('managed-add');
    const managedPath = writeManaged(cwd, {
      patterns: { add: [{ id: 'vault-delete', regex: '\\bvault\\s+delete\\b', tier: 'reconsider', reason: 'internal secrets store deletion' }] },
    });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    const added = sets.bash.find((p) => p.id === 'vault-delete');
    expect(added).toBeDefined();
    expect(added?.policy).toBe('reconsider');
    expect(added?.source).toBe('managed');
    expect(added!.re.test('vault delete secret/foo')).toBe(true);
  });

  test('applies to both bash and content by default', () => {
    const cwd = freshDir('managed-add-both');
    const managedPath = writeManaged(cwd, {
      patterns: { add: [{ id: 'internal-deploy-force', regex: '\\binternal-deploy\\s+--force\\b', tier: 'advise', reason: 'internal deploy CLI force flag' }] },
    });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.some((p) => p.id === 'internal-deploy-force')).toBe(true);
    expect(sets.content.some((p) => p.id === 'internal-deploy-force')).toBe(true);
  });

  test('appliesTo restricts a pattern to just bash', () => {
    const cwd = freshDir('managed-applies-to');
    const managedPath = writeManaged(cwd, {
      patterns: { add: [{ id: 'bash-only-rule', regex: '\\bfoo-cli\\s+nuke\\b', tier: 'advise', reason: 'internal nuke command', appliesTo: ['bash'] }] },
    });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.some((p) => p.id === 'bash-only-rule')).toBe(true);
    expect(sets.content.some((p) => p.id === 'bash-only-rule')).toBe(false);
  });
});

describe('managed policy — patterns.override', () => {
  test('disables a built-in pattern id ("off")', () => {
    const cwd = freshDir('managed-off');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'rm-rf-home': 'off' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.some((p) => p.id === 'rm-rf-home')).toBe(false);
    // Unrelated built-ins are untouched.
    expect(sets.bash.some((p) => p.id === 'rm-rf-root')).toBe(true);
  });

  test('raises a built-in pattern to "block"', () => {
    const cwd = freshDir('managed-block');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'rm-rf-root': 'block' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    const p = sets.bash.find((x) => x.id === 'rm-rf-root');
    expect(p?.policy).toBe('block');
  });

  test('lowers a built-in pattern to "advise" (managed is fully trusted)', () => {
    const cwd = freshDir('managed-lower');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'git-reset-hard': 'advise' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    const p = sets.bash.find((x) => x.id === 'git-reset-hard');
    expect(p?.policy).toBe('advise');
  });
});

describe('project policy — tighten-only', () => {
  test('project may add a new pattern', () => {
    const repoRoot = freshDir('proj-add');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    writeProject(repoRoot, {
      patterns: { add: [{ id: 'proj-custom-rule', regex: '\\bcustom-tool\\s+destroy\\b', tier: 'reconsider', reason: 'project-local destructive tool' }] },
    });
    const sets = getEffectivePatternSets(repoRoot, noManaged(repoRoot));
    const p = sets.bash.find((x) => x.id === 'proj-custom-rule');
    expect(p).toBeDefined();
    expect(p?.source).toBe('project');
  });

  test('project may raise a built-in tier (advise → reconsider)', () => {
    const repoRoot = freshDir('proj-raise');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    writeProject(repoRoot, { patterns: { override: { 'ssh-private-key': 'reconsider' } } });
    const sets = getEffectivePatternSets(repoRoot, noManaged(repoRoot));
    const p = sets.paths.find((x) => x.id === 'ssh-private-key');
    expect(p?.policy).toBe('reconsider');
  });

  test('project may raise a built-in tier all the way to "block"', () => {
    const repoRoot = freshDir('proj-raise-block');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    writeProject(repoRoot, { patterns: { override: { 'rm-rf-root': 'block' } } });
    const sets = getEffectivePatternSets(repoRoot, noManaged(repoRoot));
    const p = sets.bash.find((x) => x.id === 'rm-rf-root');
    expect(p?.policy).toBe('block');
  });

  test('project CANNOT disable a built-in pattern ("off" is rejected, original tier kept)', () => {
    const repoRoot = freshDir('proj-cannot-off');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    writeProject(repoRoot, { patterns: { override: { 'rm-rf-root': 'off' } } });
    const sets = getEffectivePatternSets(repoRoot, noManaged(repoRoot));
    const p = sets.bash.find((x) => x.id === 'rm-rf-root');
    expect(p).toBeDefined();
    expect(p?.policy).toBe('reconsider'); // unchanged from built-in
  });

  test('project CANNOT lower a built-in tier (reconsider → advise rejected)', () => {
    const repoRoot = freshDir('proj-cannot-lower');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    writeProject(repoRoot, { patterns: { override: { 'rm-rf-root': 'advise' } } });
    const sets = getEffectivePatternSets(repoRoot, noManaged(repoRoot));
    const p = sets.bash.find((x) => x.id === 'rm-rf-root');
    expect(p?.policy).toBe('reconsider'); // relaxation rejected, original tier kept
  });

  test('project cannot relax a MANAGED-set "block" back down', () => {
    const repoRoot = freshDir('proj-cannot-relax-managed');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    const managedPath = writeManaged(repoRoot, { patterns: { override: { 'rm-rf-root': 'block' } } });
    writeProject(repoRoot, { patterns: { override: { 'rm-rf-root': 'advise' } } });
    const sets = getEffectivePatternSets(repoRoot, { ROSETTA_POLICY_FILE: managedPath });
    const p = sets.bash.find((x) => x.id === 'rm-rf-root');
    expect(p?.policy).toBe('block');
  });
});

describe('precedence — managed > project > built-in', () => {
  test('managed override wins even when project tries to contradict it', () => {
    const repoRoot = freshDir('precedence');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    const managedPath = writeManaged(repoRoot, { patterns: { override: { 'kubectl-delete-prod': 'block' } } });
    writeProject(repoRoot, { patterns: { override: { 'kubectl-delete-prod': 'reconsider' } } }); // a "lower" than block, rejected
    const sets = getEffectivePatternSets(repoRoot, { ROSETTA_POLICY_FILE: managedPath });
    const p = sets.bash.find((x) => x.id === 'kubectl-delete-prod');
    expect(p?.policy).toBe('block');
  });

  test('both layers can add independent patterns and both apply', () => {
    const repoRoot = freshDir('precedence-add-both');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    const managedPath = writeManaged(repoRoot, {
      patterns: { add: [{ id: 'managed-rule', regex: '\\bmanaged-cmd\\b', tier: 'advise', reason: 'managed rule' }] },
    });
    writeProject(repoRoot, {
      patterns: { add: [{ id: 'project-rule', regex: '\\bproject-cmd\\b', tier: 'advise', reason: 'project rule' }] },
    });
    const sets = getEffectivePatternSets(repoRoot, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.some((p) => p.id === 'managed-rule')).toBe(true);
    expect(sets.bash.some((p) => p.id === 'project-rule')).toBe(true);
  });
});

describe('invalid / unsafe regex rejection', () => {
  test('a pattern with an unparsable regex is rejected, rest of file still applies', () => {
    const cwd = freshDir('bad-regex');
    const managedPath = writeManaged(cwd, {
      patterns: {
        add: [
          { id: 'bad-regex-rule', regex: '(unclosed', tier: 'advise', reason: 'malformed' },
          { id: 'good-rule', regex: '\\bok-cmd\\b', tier: 'advise', reason: 'perfectly fine' },
        ],
      },
    });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.some((p) => p.id === 'bad-regex-rule')).toBe(false);
    expect(sets.bash.some((p) => p.id === 'good-rule')).toBe(true);
  });

  test('a nested-quantifier (catastrophic-backtracking-shaped) regex is rejected', () => {
    const cwd = freshDir('redos-shape');
    const managedPath = writeManaged(cwd, {
      patterns: { add: [{ id: 'redos-rule', regex: '(a+)+$', tier: 'advise', reason: 'suspicious shape' }] },
    });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.some((p) => p.id === 'redos-rule')).toBe(false);
  });

  test('an over-long regex source is rejected', () => {
    const cwd = freshDir('long-regex');
    const managedPath = writeManaged(cwd, {
      patterns: { add: [{ id: 'too-long', regex: 'a'.repeat(500), tier: 'advise', reason: 'too long' }] },
    });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.some((p) => p.id === 'too-long')).toBe(false);
  });

  test('an invalid id (bad characters) is rejected', () => {
    const cwd = freshDir('bad-id');
    const managedPath = writeManaged(cwd, {
      patterns: { add: [{ id: 'Not Valid ID!', regex: '\\bfoo\\b', tier: 'advise', reason: 'bad id' }] },
    });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.some((p) => p.label === 'Not Valid ID!')).toBe(false);
  });

  test('an invalid tier value is rejected', () => {
    const cwd = freshDir('bad-tier');
    const managedPath = writeManaged(cwd, {
      patterns: { add: [{ id: 'bad-tier-rule', regex: '\\bfoo\\b', tier: 'deny-forever', reason: 'nonsense tier' }] },
    });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.some((p) => p.id === 'bad-tier-rule')).toBe(false);
  });
});

describe('invalid policy file → fall back to built-ins, never crash', () => {
  test('malformed JSON → built-ins only, no throw', () => {
    const cwd = freshDir('malformed-json');
    const managedPath = writeManaged(cwd, '{ not valid json');
    expect(() => getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath })).not.toThrow();
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.length).toBe(DANGEROUS_BASH.length);
  });

  test('wrong top-level shape (array instead of object) → built-ins only, no throw', () => {
    const cwd = freshDir('wrong-shape');
    const managedPath = writeManaged(cwd, [1, 2, 3]);
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
    expect(sets.bash.length).toBe(DANGEROUS_BASH.length);
  });

  test('missing managed file entirely → built-ins only, no throw', () => {
    const cwd = freshDir('missing-managed');
    expect(() => getEffectivePatternSets(cwd, noManaged(cwd))).not.toThrow();
  });

  test('missing project file entirely → built-ins (+ any managed) only, no throw', () => {
    const repoRoot = freshDir('missing-project');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    expect(() => getEffectivePatternSets(repoRoot, noManaged(repoRoot))).not.toThrow();
  });
});
