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
// F3-3: org policy overlay (`.rosetta/policy.json`) — MVP.
//
// Precedence: managed > project > built-in.
//   managed: `ROSETTA_POLICY_FILE` env, else the documented per-OS managed
//            location (MDM-deployed). Full authority: can add patterns,
//            raise/lower any built-in pattern's tier, and disable
//            (`"off"`) a built-in pattern id — BUT only once the file itself
//            is verified trustworthy (see "managed-layer trust" below); an
//            untrusted "managed" file is downgraded to project (tighten-only)
//            authority for this evaluation.
//   project: `<repo-root>/.rosetta/policy.json`. May only TIGHTEN: add new
//            patterns freely (a new check can never relax anything), and
//            raise (never lower, never disable) an already-effective tier.
//
// SAFETY (org regexes run on EVERY tool call):
//   - compiled at load time; a pattern that fails to compile, or whose shape
//     fails the conservative syntax allowlist below, is rejected.
//   - regex source length and the number of added patterns per file are
//     capped.
//   - matching cost is bounded: an ORG-supplied pattern (added or one that
//     overrode a built-in id) is tested per shell-segment against a bounded
//     prefix of each segment of the candidate string, not the whole string —
//     see `dangerous-actions/evaluate.ts` (`MAX_ORG_MATCH_INPUT_LENGTH`,
//     P1-3). Built-in patterns are unaffected — they already carry their own
//     anti-quadratic invariants and scaling tests (see patterns.ts).
//   - a missing policy file is normal (no policy configured) and is silent.
//     A present-but-invalid file (bad JSON / wrong shape) is logged (via the
//     existing best-effort debug log) and that file's policy is dropped
//     entirely — evaluation falls back to whatever the OTHER layer (or the
//     built-ins) already produced. This never throws.
//
// MANAGED-LAYER TRUST (P2-6):
//   The "managed" layer is granted full authority — including disabling a
//   built-in guard entirely — so its file must actually be admin-controlled,
//   not just "whatever `ROSETTA_POLICY_FILE` happens to point at": that env
//   var can be set by repo-committed IDE/editor settings, and even the
//   platform-default Windows location (`%ProgramData%\Rosetta`) is, by
//   default, creatable by a standard user. On POSIX, a candidate managed file
//   (default path OR `ROSETTA_POLICY_FILE`) is trusted as "managed" only when
//   it is owned by uid 0 and is not group- or world-writable; otherwise it is
//   loaded with PROJECT (tighten-only) authority instead, and why is
//   debug-logged. On Windows there is no cheap, dependency-free ACL check
//   available, so the platform-default path is documented (README) as
//   requiring an admin-only ACL from MDM and is trusted as-is; a
//   `ROSETTA_POLICY_FILE` override on Windows is always treated as
//   tighten-only (project authority), since that env var is exactly the
//   attacker-controllable input this check exists for.
// ---------------------------------------------------------------------------

export type EffectiveTier = 'advise' | 'reconsider' | 'block';
export type PolicyTier = EffectiveTier | 'off';

const TIER_RANK: Readonly<Record<PolicyTier, number>> = { off: 0, advise: 1, reconsider: 2, block: 3 };

/** Exported so callers (e.g. `dangerous-actions/evaluate.ts`) can compare/rank tiers without
 *  duplicating this table. */
export const tierRank = (tier: EffectiveTier): number => TIER_RANK[tier];

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
  /** Map, not a plain object — see P2-5: a plain `{}` keyed by an attacker-controlled pattern
   *  id (`ID_RE` permits `constructor`) inherits `Object.prototype` members, so a bracket
   *  lookup for a key that was never actually set can silently return a non-tier value
   *  (e.g. `{}['constructor']` is `Object`, not `undefined`). A `Map` has no prototype-chain
   *  lookup surface at all. */
  overrides: ReadonlyMap<string, PolicyTier>;
}

// --- regex safety -----------------------------------------------------------

const MAX_REGEX_SOURCE_LENGTH = 300;
const MAX_ADDED_PATTERNS_PER_FILE = 100;
/** Cap on how much of a single shell-segment of a candidate string an ORG-supplied pattern is
 *  tested against — see `dangerous-actions/evaluate.ts` (P1-3) for how the segmenting itself
 *  works; this module only owns the constant. */
export const MAX_ORG_MATCH_INPUT_LENGTH = 4000;

// ---------------------------------------------------------------------------
// P1-2: regex-shape safety net for org-supplied patterns.
//
// The previous version of this check was a single heuristic regex
// (`/\([^()]*[+*][^()]*\)[+*]/`) that only caught a quantified group whose
// entire body sat between two UNNESTED parens with no alternation inside —
// so it missed `(a|a)*$`, `((a+))+$`, `(a+){2,}`, and (despite a comment
// that claimed otherwise) `(a|aa)+` too. `(a|a)*$` alone took ~39s to fail
// to match a 29-character adversarial string — long enough to hang every
// hook invocation project-wide, since a project policy file is
// repo-controlled (fail-open by DoS).
//
// Rather than pattern-match the source text for more shapes (an arms race),
// this is a small tokenizer that walks the regex source once and enforces a
// conservative ALLOWLIST:
//   - a quantifier (`*`, `+`, `?`, `{n,m}`, `{n,}`) may only follow a SINGLE
//     ATOM — a literal character, an escape (`\s`, `\d`, `\w`, `\.`, …), or a
//     character class (`[...]`). It may never follow a group close (`)`) or
//     another quantifier.
//   - backreferences (`\1`-`\9`, `\k<name>`) are rejected outright.
//   - lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`) is rejected outright.
//   - groups may nest at most `MAX_GROUP_DEPTH` deep.
// This can reject some pathological-looking but perfectly linear patterns
// (e.g. `(?:foo)+` — a quantified group, even though `foo` is atomic) — that
// tradeoff is intentional: org regexes are a narrow, security-sensitive
// surface, and a false rejection just means the pattern must be rewritten
// without the group, not a hang.
// ---------------------------------------------------------------------------

const MAX_GROUP_DEPTH = 2;

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** Tokenizes `source` (a regex source string that ALREADY compiled successfully) and returns
 *  whether its shape is on the conservative safe-allowlist described above. Never throws —
 *  a shape this scanner doesn't understand is rejected, not crashed on. */
const isSafeRegexShape = (source: string): boolean => {
  let i = 0;
  const n = source.length;
  let groupDepth = 0;
  // What immediately precedes the current scan position, for quantifier legality:
  //   'single'    — a single literal char / escape / char-class: quantifiable.
  //   'group'     — a just-closed `(...)`: NOT quantifiable (that's the whole point).
  //   'quantified'— an atom that was already quantified: a second quantifier is rejected too.
  //   'none'      — start of input/group/alternative, or after an anchor: not quantifiable.
  let prevAtom: 'single' | 'group' | 'quantified' | 'none' = 'none';

  try {
    while (i < n) {
      const c = source[i];

      if (c === '\\') {
        if (i + 1 >= n) return false; // trailing backslash — shouldn't happen post-compile, be safe
        const next = source[i + 1];
        if (isDigit(next) && next !== '0') return false; // \1-\9 backreference
        if (next === 'k' && source[i + 2] === '<') return false; // \k<name> named backreference
        i += 2;
        prevAtom = 'single';
        continue;
      }

      if (c === '[') {
        // Character class: scan to the matching unescaped `]`. A leading `^` (negation) and/or
        // a leading `]` (literal `]` as the class's first member) do not close the class.
        let j = i + 1;
        if (source[j] === '^') j++;
        if (source[j] === ']') j++;
        while (j < n && source[j] !== ']') {
          j += source[j] === '\\' ? 2 : 1;
        }
        if (j >= n) return false; // unterminated — shouldn't happen post-compile
        i = j + 1;
        prevAtom = 'single';
        continue;
      }

      if (c === '(') {
        groupDepth++;
        if (groupDepth > MAX_GROUP_DEPTH) return false;
        if (source[i + 1] === '?') {
          const kind = source[i + 2];
          if (kind === '=' || kind === '!') return false; // lookahead
          if (kind === '<' && (source[i + 3] === '=' || source[i + 3] === '!')) return false; // lookbehind
          // else `(?:...)` non-capturing, or `(?<name>...)` named capturing: allowed.
        }
        i++;
        prevAtom = 'none';
        continue;
      }

      if (c === ')') {
        if (groupDepth === 0) return false; // unbalanced — shouldn't happen post-compile
        groupDepth--;
        i++;
        prevAtom = 'group';
        continue;
      }

      if (c === '|') {
        i++;
        prevAtom = 'none';
        continue;
      }

      if (c === '^' || c === '$') {
        i++;
        prevAtom = 'none'; // a zero-width anchor is never itself a quantifiable atom
        continue;
      }

      if (c === '*' || c === '+' || c === '?') {
        if (prevAtom !== 'single') return false;
        i++;
        if (source[i] === '?') i++; // lazy modifier
        prevAtom = 'quantified';
        continue;
      }

      if (c === '{') {
        const close = source.indexOf('}', i);
        const inner = close === -1 ? '' : source.slice(i + 1, close);
        if (close === -1 || !/^\d+(,\d*)?$/.test(inner)) {
          // Not valid `{n}`/`{n,}`/`{n,m}` quantifier syntax — a literal `{`.
          i++;
          prevAtom = 'single';
          continue;
        }
        if (prevAtom !== 'single') return false;
        i = close + 1;
        if (source[i] === '?') i++; // lazy modifier
        prevAtom = 'quantified';
        continue;
      }

      // Any other character (literal, `.`, etc.) is a single atom.
      i++;
      prevAtom = 'single';
    }
  } catch {
    return false;
  }

  return groupDepth === 0;
};

const compileSafeRegex = (source: string): RegExp | null => {
  if (typeof source !== 'string' || source.length === 0 || source.length > MAX_REGEX_SOURCE_LENGTH) return null;
  if (!isSafeRegexShape(source)) return null;
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

// --- managed-layer trust (P2-6) ------------------------------------------------

export interface ManagedTrustDeps {
  platform: NodeJS.Platform;
  /** Injectable so tests can simulate root-owned/non-writable (or not) files without needing
   *  actual root privileges or real file ownership on the test machine. */
  statSync: (filePath: string) => { uid: number; mode: number };
}

const defaultManagedTrustDeps: ManagedTrustDeps = {
  platform: process.platform,
  statSync: (filePath: string) => fs.statSync(filePath),
};

export interface ManagedTrustResult {
  trusted: boolean;
  reason: string;
}

/** Decides whether a candidate managed-policy file actually gets MANAGED (full, `"off"`-capable)
 *  authority, or is downgraded to PROJECT (tighten-only) authority. See the module-level comment
 *  ("MANAGED-LAYER TRUST") for the policy this implements. Never throws. */
export const evaluateManagedTrust = (
  filePath: string,
  usedEnvOverride: boolean,
  deps: ManagedTrustDeps = defaultManagedTrustDeps,
): ManagedTrustResult => {
  if (deps.platform === 'win32') {
    if (usedEnvOverride) {
      return { trusted: false, reason: 'windows-env-override-is-tighten-only' };
    }
    return { trusted: true, reason: 'windows-default-managed-path-trusted-by-convention' };
  }
  try {
    const st = deps.statSync(filePath);
    if (st.uid !== 0) {
      return { trusted: false, reason: `not-owned-by-root (uid=${st.uid})` };
    }
    if ((st.mode & 0o022) !== 0) {
      return { trusted: false, reason: `group-or-world-writable (mode=${(st.mode & 0o777).toString(8)})` };
    }
    return { trusted: true, reason: 'root-owned-and-not-group-or-world-writable' };
  } catch (err) {
    return { trusted: false, reason: `stat-failed: ${(err as Error)?.message}` };
  }
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

/** allowOff: only a TRUSTED managed layer may disable (`"off"`) a pattern (P2-6: an untrusted
 *  "managed" file is loaded through this same function with `allowOff: false`, i.e. with
 *  project/tighten-only authority). */
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

  // P2-5: a Map, not a plain object — see the ValidatedPolicy.overrides doc comment.
  // `Object.entries` (not `for...in`) already limits this to the JSON file's own enumerable
  // keys, so no prototype-pollution risk on the WRITE side; the risk this avoids is entirely on
  // the READ side, in `applyOverrides` below.
  const overrides = new Map<string, PolicyTier>();
  for (const [id, tierRaw] of Object.entries(rawOverride)) {
    if (!isValidTier(tierRaw)) {
      debugLog('policy:invalid-override-tier', { filePath, id });
      continue;
    }
    if (tierRaw === 'off' && !opts.allowOff) {
      debugLog('policy:project-cannot-disable', { filePath, id });
      continue;
    }
    overrides.set(id, tierRaw);
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
  overrides: ReadonlyMap<string, PolicyTier>,
  opts: { tightenOnly: boolean },
): EffectivePattern[] => {
  const out: EffectivePattern[] = [];
  for (const p of list) {
    const requested = overrides.get(p.id);
    if (requested === undefined || !isValidTier(requested)) {
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
 * with the managed policy (if any, and if its file passes the P2-6 trust check) applied, then
 * the project policy (if any, tighten-only) applied on top. Never throws — a missing or
 * invalid policy file at either layer simply leaves that layer's contribution out.
 */
export const getEffectivePatternSets = (
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  managedTrustDeps: ManagedTrustDeps = defaultManagedTrustDeps,
): EffectivePatternSets => {
  let bash = builtinAsEffective(DANGEROUS_BASH);
  let content = builtinAsEffective(DANGEROUS_CONTENT);
  let paths = builtinAsEffective(DANGEROUS_PATHS);

  const managedPath = resolveManagedPolicyPath(env);
  const usedEnvOverride = !!env.ROSETTA_POLICY_FILE?.trim();
  let managedIsTrusted = true;
  if (fs.existsSync(managedPath)) {
    const trust = evaluateManagedTrust(managedPath, usedEnvOverride, managedTrustDeps);
    managedIsTrusted = trust.trusted;
    if (!managedIsTrusted) {
      debugLog('policy:managed-untrusted-downgraded-to-project-authority', {
        filePath: managedPath,
        usedEnvOverride,
        reason: trust.reason,
      });
    }
  }

  const managed = loadValidatedPolicy(managedPath, { allowOff: managedIsTrusted });
  if (managed) {
    const managedSource: 'managed' | 'project' = managedIsTrusted ? 'managed' : 'project';
    bash = applyOverrides(bash, managed.overrides, { tightenOnly: !managedIsTrusted });
    content = applyOverrides(content, managed.overrides, { tightenOnly: !managedIsTrusted });
    paths = applyOverrides(paths, managed.overrides, { tightenOnly: !managedIsTrusted });
    bash = appendAdded(bash, managed.added, 'bash', managedSource);
    content = appendAdded(content, managed.added, 'content', managedSource);
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
