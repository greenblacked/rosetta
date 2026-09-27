import { describe, test, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getEffectivePatternSets as getEffectivePatternSetsWithDeps,
  resolveManagedPolicyPath,
  resolveProjectPolicyPath,
  evaluateManagedTrust,
  type ManagedTrustDeps,
} from '../../src/runtime/policy';
import { DANGEROUS_BASH } from '../../src/hooks/dangerous-actions/patterns';

// Managed-layer trust depends on file ownership (root-owned, not group/world-writable). Test files
// are owned by whoever runs the suite, so simulate a trusted root-owned managed file by default;
// the P2-6 trust tests below pass their own deps explicitly.
const TRUSTED_MANAGED: ManagedTrustDeps = { platform: 'linux', statSync: () => ({ uid: 0, mode: 0o100644 }) };
const getEffectivePatternSets = (
  cwd: string,
  env?: Record<string, string | undefined>,
  deps: ManagedTrustDeps = TRUSTED_MANAGED,
) => getEffectivePatternSetsWithDeps(cwd, env, deps);

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

// P1-2: the old nested-quantifier heuristic regex only caught a narrow shape and MISSED
// `(a|a)*$`, `((a+))+$`, `(a+){2,}`, and (despite a comment that claimed otherwise) `(a|aa)+`
// too — each one could hang the hook (`(a|a)*$` alone took ~39s on a 29-char adversarial
// string). The tokenizer-based allowlist must reject all of these, fast, while still accepting
// ordinary org patterns.
describe('P1-2: regex-shape safety net (conservative tokenizer, not a shape-matching heuristic)', () => {
  const addRule = (cwd: string, regex: string): ReturnType<typeof getEffectivePatternSets> => {
    const managedPath = writeManaged(cwd, {
      patterns: { add: [{ id: 'shape-rule', regex, tier: 'advise', reason: 'shape safety test' }] },
    });
    return getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath });
  };

  const EVIL_SHAPES = [
    '(a+)+$',
    '(a|a)*$',
    '((a+))+$',
    '(a+){2,}',
    '(a|aa)+', // the OLD comment claimed this was already caught by the old heuristic — it wasn't.
  ];

  for (const regex of EVIL_SHAPES) {
    test(`rejects catastrophic-backtracking shape: ${regex}`, () => {
      const cwd = freshDir('shape-evil');
      const sets = addRule(cwd, regex);
      expect(sets.bash.some((p) => p.id === 'shape-rule')).toBe(false);
    });
  }

  test('rejecting `(a|a)*$` is fast (does not fall through to actually running it)', () => {
    const cwd = freshDir('shape-evil-perf');
    const start = performance.now();
    const sets = addRule(cwd, '(a|a)*$');
    expect(performance.now() - start).toBeLessThan(50);
    expect(sets.bash.some((p) => p.id === 'shape-rule')).toBe(false);
  });

  test('rejects a backreference', () => {
    const cwd = freshDir('shape-backref');
    const sets = addRule(cwd, '(foo)\\1');
    expect(sets.bash.some((p) => p.id === 'shape-rule')).toBe(false);
  });

  test('rejects a named backreference', () => {
    const cwd = freshDir('shape-named-backref');
    const sets = addRule(cwd, '(?<x>foo)\\k<x>');
    expect(sets.bash.some((p) => p.id === 'shape-rule')).toBe(false);
  });

  test('rejects lookahead', () => {
    const cwd = freshDir('shape-lookahead');
    const sets = addRule(cwd, 'foo(?=bar)');
    expect(sets.bash.some((p) => p.id === 'shape-rule')).toBe(false);
  });

  test('rejects negative lookahead', () => {
    const cwd = freshDir('shape-neg-lookahead');
    const sets = addRule(cwd, 'foo(?!bar)');
    expect(sets.bash.some((p) => p.id === 'shape-rule')).toBe(false);
  });

  test('rejects lookbehind', () => {
    const cwd = freshDir('shape-lookbehind');
    const sets = addRule(cwd, '(?<=foo)bar');
    expect(sets.bash.some((p) => p.id === 'shape-rule')).toBe(false);
  });

  test('rejects a non-capturing group that is itself quantified (still a quantified group)', () => {
    const cwd = freshDir('shape-noncap-quantified');
    const sets = addRule(cwd, '(?:foo)+');
    expect(sets.bash.some((p) => p.id === 'shape-rule')).toBe(false);
  });

  test('rejects groups nested more than 2 deep', () => {
    const cwd = freshDir('shape-deep-nest');
    const sets = addRule(cwd, '(a(b(c)))');
    expect(sets.bash.some((p) => p.id === 'shape-rule')).toBe(false);
  });

  const LEGIT_SHAPES: readonly string[] = [
    String.raw`terraform\s+destroy`,
    String.raw`kubectl\s+delete\s+(ns|namespace)\b`,
    String.raw`\bvault\s+delete\b`,
    String.raw`[a-z]+\s+nuke`,
    String.raw`foo-cli\s+--force`,
  ];

  for (const regex of LEGIT_SHAPES) {
    test(`accepts legitimate org pattern: ${regex}`, () => {
      const cwd = freshDir('shape-legit');
      const sets = addRule(cwd, regex);
      expect(sets.bash.some((p) => p.id === 'shape-rule')).toBe(true);
    });
  }
});

// P2-5: `overrides` used to be a plain `{}`, and `ID_RE` permits `constructor` as a pattern id.
// A managed policy could ADD a pattern with `id: "constructor"`; when that pattern then went
// through the project layer's `applyOverrides` (even with an EMPTY project override map), a
// plain-object lookup `overrides['constructor']` returned the inherited `Object.prototype`
// constructor function instead of `undefined` — silently corrupting that pattern's tier instead
// of leaving it alone.
describe('P2-5: no Object.prototype collision via a "constructor"-id pattern', () => {
  test('a managed-added pattern with id "constructor" survives an EMPTY project policy unchanged', () => {
    const repoRoot = freshDir('proto-collision');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    const managedPath = writeManaged(repoRoot, {
      patterns: {
        add: [{ id: 'constructor', regex: '\\bdangerous-ctor-cmd\\b', tier: 'block', reason: 'constructor-id pattern' }],
      },
    });
    // An empty (but present) project policy file is exactly what makes `Object.entries({})`
    // produce a plain `{}` overrides object in the pre-fix code.
    writeProject(repoRoot, { patterns: {} });
    const sets = getEffectivePatternSets(repoRoot, { ROSETTA_POLICY_FILE: managedPath });
    const p = sets.bash.find((x) => x.id === 'constructor');
    expect(p).toBeDefined();
    expect(p?.policy).toBe('block'); // unchanged — not corrupted into some non-tier value
  });

  test('a project policy explicitly overriding id "constructor" still works normally', () => {
    const repoRoot = freshDir('proto-collision-explicit');
    fs.mkdirSync(path.join(repoRoot, '.git'));
    const managedPath = writeManaged(repoRoot, {
      patterns: {
        add: [{ id: 'constructor', regex: '\\bdangerous-ctor-cmd\\b', tier: 'advise', reason: 'constructor-id pattern' }],
      },
    });
    writeProject(repoRoot, { patterns: { override: { constructor: 'reconsider' } } }); // a legitimate raise
    const sets = getEffectivePatternSets(repoRoot, { ROSETTA_POLICY_FILE: managedPath });
    const p = sets.bash.find((x) => x.id === 'constructor');
    expect(p?.policy).toBe('reconsider');
  });
});

// P2-6: the managed layer's full authority (can even disable a built-in guard via `"off"`) is
// only meaningful if the file is actually admin-controlled. On POSIX that means root-owned and
// not group/world-writable; a file that fails that check must be downgraded to project
// (tighten-only) authority instead, with no exception for the default path vs. `ROSETTA_POLICY_FILE`.
describe('P2-6: managed-layer trust — untrusted managed file is downgraded to tighten-only', () => {
  const posixDeps = (uid: number, mode: number) => ({
    platform: 'linux' as NodeJS.Platform,
    statSync: () => ({ uid, mode }),
  });

  test('root-owned, not group/world-writable → full managed authority (can set "off")', () => {
    const cwd = freshDir('trust-root-owned');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'rm-rf-home': 'off' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath }, posixDeps(0, 0o100644));
    expect(sets.bash.some((p) => p.id === 'rm-rf-home')).toBe(false); // successfully disabled
  });

  test('NOT root-owned → downgraded to tighten-only: cannot disable a built-in', () => {
    const cwd = freshDir('trust-not-root');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'rm-rf-home': 'off' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath }, posixDeps(1000, 0o100644));
    expect(sets.bash.some((p) => p.id === 'rm-rf-home')).toBe(true); // "off" rejected, tier kept
  });

  test('root-owned but WORLD-writable → downgraded to tighten-only: cannot disable a built-in', () => {
    const cwd = freshDir('trust-world-writable');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'rm-rf-home': 'off' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath }, posixDeps(0, 0o100646));
    expect(sets.bash.some((p) => p.id === 'rm-rf-home')).toBe(true);
  });

  test('root-owned but GROUP-writable → downgraded to tighten-only: cannot disable a built-in', () => {
    const cwd = freshDir('trust-group-writable');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'rm-rf-home': 'off' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath }, posixDeps(0, 0o100664));
    expect(sets.bash.some((p) => p.id === 'rm-rf-home')).toBe(true);
  });

  test('untrusted managed file CAN still raise a tier (tighten-only is still allowed to tighten)', () => {
    const cwd = freshDir('trust-untrusted-can-raise');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'git-reset-hard': 'block' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath }, posixDeps(1000, 0o100644));
    const p = sets.bash.find((x) => x.id === 'git-reset-hard');
    expect(p?.policy).toBe('block'); // raising is fine even without trust — only lowering/off needs it
  });

  test('untrusted managed file CANNOT lower a tier either (same tighten-only rule as project)', () => {
    const cwd = freshDir('trust-untrusted-cannot-lower');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'rm-rf-root': 'advise' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath }, posixDeps(1000, 0o100644));
    const p = sets.bash.find((x) => x.id === 'rm-rf-root');
    expect(p?.policy).toBe('reconsider'); // unchanged — relaxation rejected
  });

  test('stat failure on the managed file → treated as untrusted (fail closed to tighten-only)', () => {
    const cwd = freshDir('trust-stat-fails');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'rm-rf-home': 'off' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath }, {
      platform: 'linux' as NodeJS.Platform,
      statSync: () => { throw new Error('EACCES'); },
    });
    expect(sets.bash.some((p) => p.id === 'rm-rf-home')).toBe(true); // "off" rejected
  });

  test('Windows: a ROSETTA_POLICY_FILE override is always tighten-only, even though the default path is trusted', () => {
    const cwd = freshDir('trust-windows-env-override');
    const managedPath = writeManaged(cwd, { patterns: { override: { 'rm-rf-home': 'off' } } });
    const sets = getEffectivePatternSets(cwd, { ROSETTA_POLICY_FILE: managedPath }, {
      platform: 'win32' as NodeJS.Platform,
      statSync: () => { throw new Error('no ACL API on this test double'); },
    });
    // ROSETTA_POLICY_FILE WAS set, so on Windows this is the tighten-only (env-override) branch,
    // not the trusted-default-path branch — "off" must still be rejected.
    expect(sets.bash.some((p) => p.id === 'rm-rf-home')).toBe(true);
  });
});

describe('P2-6: evaluateManagedTrust (unit-level, both platform branches)', () => {
  test('POSIX: root-owned, not group/world-writable → trusted', () => {
    expect(evaluateManagedTrust('/etc/rosetta/policy.json', false, {
      platform: 'linux', statSync: () => ({ uid: 0, mode: 0o100644 }),
    }).trusted).toBe(true);
  });

  test('POSIX: not root-owned → untrusted', () => {
    expect(evaluateManagedTrust('/etc/rosetta/policy.json', false, {
      platform: 'darwin', statSync: () => ({ uid: 501, mode: 0o100600 }),
    }).trusted).toBe(false);
  });

  test('POSIX: root-owned but world-writable → untrusted', () => {
    expect(evaluateManagedTrust('/etc/rosetta/policy.json', false, {
      platform: 'linux', statSync: () => ({ uid: 0, mode: 0o100666 }),
    }).trusted).toBe(false);
  });

  test('POSIX: applies the SAME check to a ROSETTA_POLICY_FILE override as to the default path', () => {
    const trustedDefault = evaluateManagedTrust('/etc/rosetta/policy.json', false, {
      platform: 'linux', statSync: () => ({ uid: 0, mode: 0o100600 }),
    });
    const trustedOverride = evaluateManagedTrust('/repo/.rosetta-managed.json', true, {
      platform: 'linux', statSync: () => ({ uid: 0, mode: 0o100600 }),
    });
    expect(trustedDefault.trusted).toBe(true);
    expect(trustedOverride.trusted).toBe(true); // no special exemption for the env-var path
  });

  test('Windows: the default path is trusted by convention (no stat check performed)', () => {
    const result = evaluateManagedTrust('C:\\ProgramData\\Rosetta\\policy.json', false, {
      platform: 'win32', statSync: () => { throw new Error('must not be called'); },
    });
    expect(result.trusted).toBe(true);
  });

  test('Windows: a ROSETTA_POLICY_FILE override is always untrusted (tighten-only)', () => {
    const result = evaluateManagedTrust('C:\\Users\\me\\policy.json', true, {
      platform: 'win32', statSync: () => { throw new Error('must not be called'); },
    });
    expect(result.trusted).toBe(false);
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
