import fs from 'fs';
import path from 'path';
import { debugLog } from './debug-log';
import { walkUp } from './path-utils';
import {
  DANGEROUS_BASH,
  DANGEROUS_CONTENT,
  DANGEROUS_PATHS,
  type DangerPattern,
} from '../hooks/dangerous-actions/patterns';

// ---------------------------------------------------------------------------
// F3-3: org policy overlay (`rosetta-policy.json`) — MVP.
//
// Precedence: managed > project > built-in.
//   managed: `ROSETTA_POLICY_FILE` env, else the documented per-OS managed
//            location (MDM-deployed). Full authority: can add patterns,
//            raise/lower any built-in pattern's tier, and disable
//            (`"off"`) a built-in pattern id.
//   project: `<repo-root>/.rosetta/policy.json`. May only TIGHTEN: add new
//            patterns freely (a new check can never relax anything), and
//            raise (never lower, never disable) an already-effective tier.
//
// SAFETY (org regexes run on EVERY tool call):
//   - compiled at load time; a pattern that fails to compile is rejected.
//   - a simple nested-quantifier heuristic rejects classic catastrophic-
//     backtracking shapes, e.g. `(a+)+`, `(\w*)*`.
//   - regex source length and the number of added patterns per file are
//     capped.
//   - matching cost is bounded: an ORG-supplied pattern (added or one that
//     overrode a built-in id) is only tested against the first
//     `MAX_ORG_MATCH_INPUT_LENGTH` characters of the candidate string.
//     Built-in patterns are unaffected — they already carry their own
//     anti-quadratic invariants and scaling tests (see patterns.ts).
//   - a missing policy file is normal (no policy configured) and is silent.
//     A present-but-invalid file (bad JSON / wrong shape) is logged ONCE
//     (via the existing best-effort debug log) and that file's policy is
//     dropped entirely — evaluation falls back to whatever the OTHER layer
//     (or the built-ins) already produced. This never throws.
// ---------------------------------------------------------------------------

export type EffectiveTier = 'advise' | 'reconsider' | 'block';
export type PolicyTier = EffectiveTier | 'off';

const TIER_RANK: Record<PolicyTier, number> = { off: 0, advise: 1, reconsider: 2, block: 3 };

const isValidTier = (v: unknown): v is PolicyTier =>
  v === 'advise' || v === 'reconsider' || v === 'block' || v === 'off';

/** A pattern as evaluated at runtime, after built-ins are merged with any policy overlay. */
export interface EffectivePattern {
  id: string;
  re: RegExp;
  label: string;
  reason: string;
  policy: EffectiveTier;
  source: 'builtin' | 'managed' | 'project';
}

export interface EffectivePatternSets {
  bash:    readonly EffectivePattern[];
  content: readonly EffectivePattern[];
  paths:   readonly EffectivePattern[];
}

type AppliesTo = 'bash' | 'content';

interface ValidatedAddedPattern {
  id: string;
  re: RegExp;
  label: string;
  reason: string;
  tier: EffectiveTier;
  appliesTo: readonly AppliesTo[];
}

interface ValidatedPolicy {
  added: readonly ValidatedAddedPattern[];
  overrides: Readonly<Record<string, PolicyTier>>;
}

// --- regex safety -----------------------------------------------------------

const MAX_REGEX_SOURCE_LENGTH = 300;
const MAX_ADDED_PATTERNS_PER_FILE = 100;
/** Cap on how much of a candidate string an ORG-supplied pattern is tested against. */
export const MAX_ORG_MATCH_INPUT_LENGTH = 4000;

// Catches the classic catastrophic-backtracking shape: a group containing its own
// quantifier, itself quantified — e.g. `(a+)+`, `(\w*)*`, `(a|aa)+`, `([a-z]+)*`.
// Deliberately simple (a heuristic, not a full ReDoS analyzer) — it rejects the shapes
// that are cheap to construct by accident, not every possible pathological regex.
const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)[+*]/;

const isSuspiciousRegexShape = (source: string): boolean => NESTED_QUANTIFIER_RE.test(source);

const compileSafeRegex = (source: string): RegExp | null => {
  if (typeof source !== 'string' || source.length === 0 || source.length > MAX_REGEX_SOURCE_LENGTH) return null;
  if (isSuspiciousRegexShape(source)) return null;
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- validated above; this IS the validator.
    return new RegExp(source, 'i');
  } catch {
    return null;
  }
};

// --- file resolution ----------------------------------------------------------

const platformManagedPolicyPath = (): string =>
  process.platform === 'win32'
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Rosetta', 'policy.json')
    : '/etc/rosetta/policy.json';

export const resolveManagedPolicyPath = (env: Record<string, string | undefined> = process.env): string =>
  env.ROSETTA_POLICY_FILE?.trim() || platformManagedPolicyPath();

export const resolveProjectPolicyPath = (cwd: string): string => {
  const start = cwd || process.cwd();
  const repoRoot = walkUp(start, '.git') ?? start;
  return path.join(repoRoot, '.rosetta', 'policy.json');
};

// --- validation ---------------------------------------------------------------

interface RawPolicyPatternAdd {
  id?: unknown;
  regex?: unknown;
  tier?: unknown;
  reason?: unknown;
  label?: unknown;
  appliesTo?: unknown;
}

interface RawPolicyFile {
  patterns?: {
    add?: unknown;
    override?: unknown;
  };
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const validateAddedPattern = (entry: unknown, filePath: string): ValidatedAddedPattern | null => {
  if (!entry || typeof entry !== 'object') {
    debugLog('policy:invalid-pattern-entry', { filePath });
    return null;
  }
  const e = entry as RawPolicyPatternAdd;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) {
    debugLog('policy:invalid-pattern-id', { filePath });
    return null;
  }
  if (typeof e.regex !== 'string') {
    debugLog('policy:invalid-pattern-regex-type', { filePath, id: e.id });
    return null;
  }
  const re = compileSafeRegex(e.regex);
  if (!re) {
    debugLog('policy:unsafe-or-invalid-regex-rejected', { filePath, id: e.id });
    return null;
  }
  if (typeof e.reason !== 'string' || e.reason.trim().length < 5) {
    debugLog('policy:invalid-pattern-reason', { filePath, id: e.id });
    return null;
  }
  if (!isValidTier(e.tier) || e.tier === 'off') {
    debugLog('policy:invalid-pattern-tier', { filePath, id: e.id });
    return null;
  }
  const rawApplies = Array.isArray(e.appliesTo)
    ? (e.appliesTo.filter((x): x is AppliesTo => x === 'bash' || x === 'content'))
    : null;
  const appliesTo: readonly AppliesTo[] = rawApplies && rawApplies.length > 0 ? rawApplies : ['bash', 'content'];
  return {
    id: e.id,
    re,
    label: typeof e.label === 'string' && e.label.trim() ? e.label : e.id,
    reason: e.reason,
    tier: e.tier,
    appliesTo,
  };
};

/** allowOff: only the managed layer may disable (`"off"`) a pattern. */
const loadValidatedPolicy = (filePath: string, opts: { allowOff: boolean }): ValidatedPolicy | null => {
  let raw: unknown;
  try {
    if (!fs.existsSync(filePath)) return null; // no policy configured — normal, silent.
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    debugLog('policy:load-failed-fallback', { filePath, error: (err as Error)?.message });
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    debugLog('policy:invalid-shape-fallback', { filePath });
    return null;
  }

  const data = raw as RawPolicyFile;
  const rawAdd = Array.isArray(data.patterns?.add) ? (data.patterns!.add as unknown[]) : [];
  const rawOverride =
    data.patterns?.override && typeof data.patterns.override === 'object' && !Array.isArray(data.patterns.override)
      ? (data.patterns.override as Record<string, unknown>)
      : {};

  if (rawAdd.length > MAX_ADDED_PATTERNS_PER_FILE) {
    debugLog('policy:too-many-added-patterns', { filePath, count: rawAdd.length, max: MAX_ADDED_PATTERNS_PER_FILE });
  }

  const added: ValidatedAddedPattern[] = [];
  const seenIds = new Set<string>();
  for (const entry of rawAdd.slice(0, MAX_ADDED_PATTERNS_PER_FILE)) {
    const validated = validateAddedPattern(entry, filePath);
    if (validated && !seenIds.has(validated.id)) {
      added.push(validated);
      seenIds.add(validated.id);
    }
  }

  const overrides: Record<string, PolicyTier> = {};
  for (const [id, tierRaw] of Object.entries(rawOverride)) {
    if (!isValidTier(tierRaw)) {
      debugLog('policy:invalid-override-tier', { filePath, id });
      continue;
    }
    if (tierRaw === 'off' && !opts.allowOff) {
      debugLog('policy:project-cannot-disable', { filePath, id });
      continue;
    }
    overrides[id] = tierRaw;
  }

  return { added, overrides };
};

// --- merge --------------------------------------------------------------------

const builtinAsEffective = (patterns: readonly DangerPattern[]): EffectivePattern[] =>
  patterns.map((p) => ({ id: p.id, re: p.re, label: p.label, reason: p.reason, policy: p.policy, source: 'builtin' }));

/** Apply an `overrides` map to a pattern list. `tightenOnly` rejects any override that would
 *  disable a pattern or lower its tier below what it already effectively is. */
const applyOverrides = (
  list: readonly EffectivePattern[],
  overrides: Readonly<Record<string, PolicyTier>>,
  opts: { tightenOnly: boolean },
): EffectivePattern[] => {
  const out: EffectivePattern[] = [];
  for (const p of list) {
    const requested = overrides[p.id];
    if (requested === undefined) {
      out.push(p);
      continue;
    }
    const isRelaxation = TIER_RANK[requested] < TIER_RANK[p.policy];
    if (opts.tightenOnly && (requested === 'off' || isRelaxation)) {
      debugLog('policy:override-rejected-relaxation', { id: p.id, current: p.policy, requested });
      out.push(p);
      continue;
    }
    if (requested === 'off') continue; // managed-only disable — drop the pattern.
    out.push({ ...p, policy: requested });
  }
  return out;
};

const appendAdded = (
  list: readonly EffectivePattern[],
  added: readonly ValidatedAddedPattern[],
  category: AppliesTo,
  source: 'managed' | 'project',
): EffectivePattern[] => {
  const extra = added
    .filter((a) => a.appliesTo.includes(category))
    .map((a): EffectivePattern => ({ id: a.id, re: a.re, label: a.label, reason: a.reason, policy: a.tier, source }));
  return [...list, ...extra];
};

/**
 * Compute the effective bash/content/path pattern sets for this evaluation: built-ins,
 * with the managed policy (if any) applied, then the project policy (if any, tighten-only)
 * applied on top. Never throws — a missing or invalid policy file at either layer simply
 * leaves that layer's contribution out.
 */
export const getEffectivePatternSets = (
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): EffectivePatternSets => {
  let bash = builtinAsEffective(DANGEROUS_BASH);
  let content = builtinAsEffective(DANGEROUS_CONTENT);
  let paths = builtinAsEffective(DANGEROUS_PATHS);

  const managed = loadValidatedPolicy(resolveManagedPolicyPath(env), { allowOff: true });
  if (managed) {
    bash = applyOverrides(bash, managed.overrides, { tightenOnly: false });
    content = applyOverrides(content, managed.overrides, { tightenOnly: false });
    paths = applyOverrides(paths, managed.overrides, { tightenOnly: false });
    bash = appendAdded(bash, managed.added, 'bash', 'managed');
    content = appendAdded(content, managed.added, 'content', 'managed');
  }

  const project = loadValidatedPolicy(resolveProjectPolicyPath(cwd), { allowOff: false });
  if (project) {
    bash = applyOverrides(bash, project.overrides, { tightenOnly: true });
    content = applyOverrides(content, project.overrides, { tightenOnly: true });
    paths = applyOverrides(paths, project.overrides, { tightenOnly: true });
    bash = appendAdded(bash, project.added, 'bash', 'project');
    content = appendAdded(content, project.added, 'content', 'project');
  }

  return { bash, content, paths };
};
