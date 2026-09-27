// Rosetta-AI-reviewed: pattern definitions only — not executable SQL/shell
import { advise, deny } from '../../runtime/result-helpers';
import { debugLogHookBranch } from '../../runtime/debug-log';
import { appendAuditRecord, type AuditDecision } from '../../runtime/audit';
import {
  getEffectivePatternSets,
  MAX_ORG_MATCH_INPUT_LENGTH,
  tierRank,
  type EffectivePattern,
  type EffectivePatternSets,
} from '../../runtime/policy';
import type { HookContext, HookResult } from '../../runtime/types';

/**
 * Matches the `Rosetta-AI-reviewed` brand token with word boundaries on both sides.
 * Accepts any surrounding context: `# Rosetta-AI-reviewed`, `-- Rosetta-AI-reviewed`,
 * plain `Rosetta-AI-reviewed`. Rejects merged words like `XRosetta-AI-reviewedY`.
 */
const MARKER_RE = /\bRosetta-AI-reviewed\b/;

/** User-visible payload fields where the `Rosetta-AI-reviewed` marker is accepted, by tool name.
 *  Restricted to write-time content fields only — path fields and pattern-match fields
 *  (file_path, old_string) are excluded to prevent changing the operation target. */
const MARKER_FIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  Bash:      ['command'],
  Write:     ['content'],
  Edit:      ['new_string'],
  MultiEdit: ['edits'],
};

const MCP_MARKER_FIELDS = ['command', 'sql', 'query', 'new_string', 'content'] as const;

/** A9: for a tool field that holds an array of edit objects (MultiEdit's `edits`), only these
 *  sub-fields are user-visible write-time content — `old_string` is EXISTING file text the
 *  operation targets, not content the caller asserts, so it must not carry the marker any more
 *  than Edit's `old_string` does. A tool with no entry here keeps the prior full-object scan
 *  (MCP tools' array fields have no established shape to allowlist). */
const MARKER_ARRAY_ITEM_SUBFIELDS_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  MultiEdit: ['new_string'],
};

const MCP_SHELL_FIELDS   = ['command', 'cmd', 'shell_command'] as const;
const MCP_PATH_FIELDS    = ['path', 'file_path', 'filePath', 'target', 'target_path'] as const;
const MCP_CONTENT_FIELDS = ['content', 'new_string', 'query', 'sql'] as const;

type PatternHit = { result: HookResult; pattern: EffectivePattern | null };

/** The write-time field an override marker should be appended to, by tool kind.
 *  MCP tools (toolKind is the mcp__… name) fall through to the generic wording. */
function overrideField(toolKind: string): string {
  switch (toolKind) {
    case 'bash':       return '`command`';
    case 'write':      return '`content`';
    case 'edit':       return '`new_string`';
    case 'multi-edit': return '`new_string` (in the relevant `edits[]` entry)';
    default:           return 'the relevant string';
  }
}

/** Soft-deny message (policy 'reconsider'). Per the review directive the message is
 *  intentionally minimal: a static generic reason, one coaching line, and how to
 *  override. It NEVER echoes the command/payload — the AI already knows what it ran. */
function buildReconsiderDenyMessage(pattern: EffectivePattern, toolKind: string): string {
  return [
    `Dangerous action [${pattern.id}]: ${pattern.reason}`,
    'Check blast radius / recoverability first.',
    `Override: append \`# Rosetta-AI-reviewed\` comment to the ${overrideField(toolKind)} field if intended.`,
  ].join('\n');
}

/** Non-blocking safety nudge (policy 'advise'). Warns without denying — the action
 *  still proceeds. Same minimal shape: static reason, no evidence echo. */
function buildAdviseMessage(pattern: EffectivePattern): string {
  return [
    `Heads-up [${pattern.id}]: ${pattern.reason}`,
    'Non-blocking notice — confirm this is intended before proceeding.',
  ].join('\n');
}

/** Hard-deny message (F3-3 policy 'block'). Unlike 'reconsider', there is deliberately NO
 *  override instruction here — the `Rosetta-AI-reviewed` marker is never consulted for a
 *  'block'-tier pattern (see evaluateDangerous). Only reachable through a policy overlay
 *  (a trusted managed policy can set it directly; a project policy can only TIGHTEN a
 *  pattern's tier up to and including 'block', never set it on its own) — it is never a
 *  built-in tier. */
function buildBlockDenyMessage(pattern: EffectivePattern): string {
  return [
    `Blocked by organization policy [${pattern.id}]: ${pattern.reason}`,
    'This action cannot be overridden by the agent.',
    'Ask a human to run it outside the agent if it is genuinely required.',
  ].join('\n');
}

/** Build the hook result for a matched pattern, dispatching on its policy tier.
 *  'advise' → non-blocking notice; 'reconsider' → soft-deny (overridable);
 *  'block' → hard-deny (never overridable, org-policy only). */
function buildResultForPattern(pattern: EffectivePattern, toolKind: string): HookResult {
  if (pattern.policy === 'advise') {
    return advise(buildAdviseMessage(pattern));
  }
  if (pattern.policy === 'block') {
    return deny(buildBlockDenyMessage(pattern));
  }
  return deny(buildReconsiderDenyMessage(pattern, toolKind));
}

// ---------------------------------------------------------------------------
// P1-1: block-tier shadowing fix.
//
// A managed/project policy can ADD a pattern (appended after the built-ins) or RAISE a
// built-in's tier via override (in place). Either way, more than one pattern in the SAME
// category (bash/content/paths) — or across the bash+content categories that both apply to a
// shell string, or the paths+content categories that both apply to a Write/Edit — can match the
// same candidate at DIFFERENT tiers. Stopping at the first match (in list/category order) lets
// a lower-tier built-in "shadow" a stricter org pattern that matches the same string but sits
// later or in a different category. Every applicable pattern is therefore evaluated, and the
// STRICTEST tier (block > reconsider > advise) wins; ties are broken by encounter order — the
// same order the pre-fix code already checked things in (bash before content, paths before
// content) — so built-in-only evaluations (never more than one *effective* tier per matching
// string in practice) resolve to the exact same pattern/message as before.
// ---------------------------------------------------------------------------

/** Picks the strictest of two possibly-null matches. On a tie, `a` wins — callers pass matches
 *  in the same precedence order the old code used to check them in, so a tie (e.g. two built-in
 *  `reconsider` matches) resolves exactly like before the fix. */
function stricterOf(a: EffectivePattern | null, b: EffectivePattern | null): EffectivePattern | null {
  if (!a) return b;
  if (!b) return a;
  return tierRank(b.policy) > tierRank(a.policy) ? b : a;
}

// ---------------------------------------------------------------------------
// P1-3: length-cap bypass fix.
//
// An ORG-supplied pattern (added, or one that overrode a built-in id) is bounded to
// `MAX_ORG_MATCH_INPUT_LENGTH` characters so a pathological org regex can't be walked across an
// arbitrarily large candidate string. Testing only the first N characters of the WHOLE string,
// though, lets a shell command hide a dangerous tail past the cap behind a long, harmless head
// (e.g. `echo <4000 a's>; wget http://evil` — the org pattern for `wget\s` never even sees the
// `wget`). The candidate is instead split on shell separators (`;`, `&&`, `||`, `|`, and line
// breaks) and each SEGMENT is capped independently, so a short dangerous segment past a long
// harmless one is still tested in full.
//
// A single segment can still itself exceed the cap (e.g. one very long line/argument). Silently
// truncating it and testing only the head could still hide a match past the cap — so when that
// happens AND at least one org pattern in this category is `block`/`reconsider` tier (i.e. an
// org policy actually governs this category), the evaluation fails CLOSED to `reconsider`
// rather than silently allowing the unverifiable remainder through.
// ---------------------------------------------------------------------------

const SHELL_SEGMENT_RE = /;|&&|\|\||\||\r\n|\r|\n/;

const splitShellSegments = (value: string): string[] => value.split(SHELL_SEGMENT_RE);

/** ORG-supplied patterns (added, or overriding a built-in id) are tested per shell-segment
 *  against a bounded prefix of each segment — part of F3-3's regex-safety story: a pattern that
 *  was validated at load time (compiled, length-capped, regex-shape allowlisted) still gets a
 *  bounded worst case at match time. Built-in patterns are untouched — they already carry their
 *  own anti-quadratic invariants and scaling tests (see patterns.ts). */
function testEffective(pattern: EffectivePattern, value: string): boolean {
  if (pattern.source === 'builtin') return pattern.re.test(value);
  return splitShellSegments(value).some((segment) => pattern.re.test(segment.slice(0, MAX_ORG_MATCH_INPUT_LENGTH)));
}

/** When any segment of `value` exceeds the per-segment cap, and `patterns` includes at least one
 *  org (non-builtin) pattern at `block`/`reconsider` tier that could have governed it, build a
 *  synthetic fail-closed match at `reconsider` tier instead of silently returning no match for
 *  the part of that segment we couldn't verify. Returns null when there's nothing to fail closed
 *  about — no oversized segment, or no org pattern in this category at all (the common case,
 *  checked first so this costs nothing when no policy overlay is configured). */
function oversizedSegmentGuard(patterns: readonly EffectivePattern[], value: string): EffectivePattern | null {
  const orgGuard = patterns.find((p) => p.source !== 'builtin' && (p.policy === 'block' || p.policy === 'reconsider'));
  if (!orgGuard) return null;
  const hasOversizedSegment = splitShellSegments(value).some((segment) => segment.length > MAX_ORG_MATCH_INPUT_LENGTH);
  if (!hasOversizedSegment) return null;
  return {
    ...orgGuard,
    policy: 'reconsider',
    reason: `${orgGuard.reason} (unable to fully verify: an input segment exceeded the ${MAX_ORG_MATCH_INPUT_LENGTH}-character policy scan limit)`,
  };
}

function matchPatterns(
  patterns: readonly EffectivePattern[],
  value: string,
): EffectivePattern | null {
  let best: EffectivePattern | null = null;
  for (const p of patterns) {
    if (testEffective(p, value)) best = stricterOf(best, p);
  }
  if (best?.policy === 'block') return best; // already maximal — no need to fail-closed-check
  return stricterOf(best, oversizedSegmentGuard(patterns, value));
}

function matchDangerousPath(
  patterns: readonly EffectivePattern[],
  filePath: string,
): EffectivePattern | null {
  // A8: normalize Windows backslashes before the `/`-only trailing-slash strip and split, so
  // `C:\Users\me\.aws\credentials` matches the same as its POSIX form.
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const basename = normalizedPath.split('/').pop() ?? normalizedPath;
  let best: EffectivePattern | null = null;
  for (const p of patterns) {
    if (testEffective(p, normalizedPath) || testEffective(p, basename)) best = stricterOf(best, p);
  }
  if (best?.policy === 'block') return best;
  return stricterOf(best, oversizedSegmentGuard(patterns, normalizedPath));
}

/**
 * Returns true if any user-visible string field for the given tool name
 * contains the retry marker `Rosetta-AI-reviewed`.
 *
 * Restricted to fields rendered in the IDE UI to prevent silent self-assertion
 * via hidden metadata fields such as `description`.
 */
export function hasAIReviewedMarker(
  input: Readonly<Record<string, unknown>>,
  toolName: string,
): boolean {
  const fields = toolName.startsWith('mcp__')
    ? MCP_MARKER_FIELDS
    : (MARKER_FIELDS_BY_TOOL[toolName] ?? MCP_MARKER_FIELDS);
  const arrayItemSubfields = MARKER_ARRAY_ITEM_SUBFIELDS_BY_TOOL[toolName];

  return fields.some(f => {
    const v = input[f];
    if (typeof v === 'string') return MARKER_RE.test(v);
    if (Array.isArray(v)) {
      return v.some(item => {
        if (typeof item === 'string') return MARKER_RE.test(item);
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          // A9: MultiEdit (and any tool with an allowlist here) scans ONLY its allowed
          // sub-fields — e.g. `new_string`, never `old_string` (existing file text the edit
          // targets, not asserted content) — matching Edit's field-level restriction above.
          const values = arrayItemSubfields
            ? arrayItemSubfields.map(sf => record[sf])
            : Object.values(record);
          return values.some(inner => typeof inner === 'string' && MARKER_RE.test(inner));
        }
        return false;
      });
    }
    return false;
  });
}

/**
 * Evaluate a shell command string against the two pattern sets that apply to a
 * free-form command:
 *   1. DANGEROUS_BASH    — command patterns (rm, git push --force, …)
 *   2. DANGEROUS_CONTENT — destructive SQL embedded in the command (e.g. psql -c "DROP …")
 * Bash patterns are checked first so a command's primary danger (e.g. rm) is the
 * one surfaced. Shared by the Bash tool and MCP shell fields so both get identical coverage.
 *
 * NOTE: DANGEROUS_PATHS is intentionally NOT scanned here. Those are advise-tier
 * key/credential-file notices; a direct Write/Edit to such a file is still caught by
 * matchDangerousPath in evalWrite/evalEdit. Extracting path targets from a free-form
 * shell string (redirects, quoting) added real complexity for only that narrow,
 * non-blocking case, so it was dropped.
 */
function evalShellString(command: string, toolKind: string, sets: EffectivePatternSets): PatternHit {
  // P1-1: evaluate BOTH categories (not bash-then-stop) so a stricter content-tier match can't
  // be shadowed by a laxer bash-tier one that happens to match first.
  const pattern = stricterOf(matchPatterns(sets.bash, command), matchPatterns(sets.content, command));
  if (pattern) return { result: buildResultForPattern(pattern, toolKind), pattern };
  return { result: null, pattern: null };
}

function evalBash(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  const command = ctx.toolInput.command;
  if (typeof command !== 'string') return { result: null, pattern: null };
  return evalShellString(command, 'bash', sets);
}

function evalWrite(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  const filePath = ctx.toolInput.file_path;
  const pathPattern = typeof filePath === 'string' ? matchDangerousPath(sets.paths, filePath) : null;
  const content = ctx.toolInput.content;
  const contentPattern = typeof content === 'string' ? matchPatterns(sets.content, content) : null;
  const pattern = stricterOf(pathPattern, contentPattern);
  if (pattern) return { result: buildResultForPattern(pattern, 'write'), pattern };
  return { result: null, pattern: null };
}

function evalEdit(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  const filePath = ctx.toolInput.file_path;
  const pathPattern = typeof filePath === 'string' ? matchDangerousPath(sets.paths, filePath) : null;
  const newString = ctx.toolInput.new_string;
  const contentPattern = typeof newString === 'string' ? matchPatterns(sets.content, newString) : null;
  const pattern = stricterOf(pathPattern, contentPattern);
  if (pattern) return { result: buildResultForPattern(pattern, 'edit'), pattern };
  return { result: null, pattern: null };
}

function evalMultiEdit(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  const filePath = ctx.toolInput.file_path;
  let pattern = typeof filePath === 'string' ? matchDangerousPath(sets.paths, filePath) : null;
  const edits = ctx.toolInput.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === 'object') {
        const ns = (edit as Record<string, unknown>).new_string;
        if (typeof ns === 'string') {
          pattern = stricterOf(pattern, matchPatterns(sets.content, ns));
        }
      }
    }
  }
  if (pattern) return { result: buildResultForPattern(pattern, 'multi-edit'), pattern };
  return { result: null, pattern: null };
}

function evalMcpCall(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  const input = ctx.toolInput;
  let pattern: EffectivePattern | null = null;

  for (const f of MCP_SHELL_FIELDS) {
    const v = input[f];
    if (typeof v === 'string') {
      pattern = stricterOf(pattern, matchPatterns(sets.bash, v));
      pattern = stricterOf(pattern, matchPatterns(sets.content, v));
    }
  }
  for (const f of MCP_PATH_FIELDS) {
    const v = input[f];
    if (typeof v === 'string') {
      pattern = stricterOf(pattern, matchDangerousPath(sets.paths, v));
    }
  }
  for (const f of MCP_CONTENT_FIELDS) {
    const v = input[f];
    if (typeof v === 'string') {
      pattern = stricterOf(pattern, matchPatterns(sets.content, v));
    }
  }
  if (pattern) return { result: buildResultForPattern(pattern, ctx.toolName), pattern };
  return { result: null, pattern: null };
}

/** Single traversal: detects the first matching pattern and returns both deny result and pattern.
 *  `sets` is the F3-3 policy-merged pattern set (built-ins + managed + project overlay), computed
 *  once per evaluation from `ctx.cwd`. */
function detectDanger(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  switch (ctx.toolKind) {
    case 'bash':       return evalBash(ctx, sets);
    case 'write':      return evalWrite(ctx, sets);
    case 'edit':       return evalEdit(ctx, sets);
    case 'multi-edit': return evalMultiEdit(ctx, sets);
    case 'mcp-call':   return evalMcpCall(ctx, sets);
    default:           return { result: null, pattern: null };
  }
}

/** Returns both the deny result and the matched pattern for policy-aware callers. */
export function evalPatternAndPolicy(ctx: HookContext): { result: HookResult; pattern: EffectivePattern | null } {
  return detectDanger(ctx, getEffectivePatternSets(ctx.cwd));
}

const AUDIT_HOOK_NAME = 'dangerous-actions';

/** F3-4: record one guardrail decision to the local audit trail. Always safe — disabled
 *  (the default) and any failure are both no-ops inside appendAuditRecord itself. */
function recordAudit(ctx: HookContext, decision: AuditDecision, pattern: EffectivePattern | null): void {
  const isPathTarget = ctx.toolKind === 'write' || ctx.toolKind === 'edit' || ctx.toolKind === 'multi-edit';
  appendAuditRecord({
    hook: AUDIT_HOOK_NAME,
    decision,
    patternId: pattern?.id ?? null,
    toolName: ctx.toolName,
    toolKind: ctx.toolKind,
    ide: ctx.ide,
    sessionId: ctx.sessionId,
    command: isPathTarget ? null : (typeof ctx.toolInput.command === 'string' ? ctx.toolInput.command : null),
    filePath: isPathTarget ? ctx.filePath : null,
    cwd: ctx.cwd,
  });
}

/**
 * Pure evaluation for the dangerous-actions hook.
 * Applies policy tier (built-in, or as tightened/extended by an F3-3 org policy overlay):
 *   - 'advise'    → non-blocking notice, always surfaced (marker is irrelevant).
 *   - 'reconsider'→ soft-deny: block this attempt unless the AI-reviewed marker is
 *                   present (the AI can re-issue with it, or stop and ask the user).
 *   - 'block'     → hard-deny: the marker is NEVER consulted. Only reachable through a policy
 *                   overlay — a trusted managed policy directly, or a project policy tightening
 *                   an already-effective tier up to 'block' (see runtime/policy.ts) — there is
 *                   still no built-in hard-deny tier, preserving the existing "hook never
 *                   hard-denies on its own" invariant.
 * Returns null if safe (no match or marker honored).
 *
 * Every branch also appends one F3-4 audit record (content-free — see runtime/audit.ts).
 *
 * @internal Used by unit tests.
 */
export function evaluateDangerous(ctx: HookContext): HookResult {
  const { result, pattern } = evalPatternAndPolicy(ctx);
  if (result === null) {
    debugLogHookBranch('dangerous-actions', 'no-match-allow', {
      toolKind: ctx.toolKind,
      toolName: ctx.toolName,
    });
    return null;
  }

  // Non-blocking advise-tier notices are always surfaced (marker is irrelevant).
  if (pattern?.policy === 'advise') {
    debugLogHookBranch('dangerous-actions', 'advise', {
      toolKind: ctx.toolKind,
      toolName: ctx.toolName,
      patternId: pattern.id,
      patternLabel: pattern.label,
    });
    recordAudit(ctx, 'advise', pattern);
    return result;
  }

  // F3-3 'block' tier: reachable only through a policy overlay (a trusted managed policy, or a
  // project policy tightening up to 'block') — never a built-in pattern tier. Hard-deny — the
  // marker is not even checked, unlike every other tier here.
  if (pattern?.policy === 'block') {
    debugLogHookBranch('dangerous-actions', 'block-deny', {
      toolKind: ctx.toolKind,
      toolName: ctx.toolName,
      patternId: pattern.id,
      patternLabel: pattern.label,
    });
    recordAudit(ctx, 'block', pattern);
    return result;
  }

  const input = ctx.toolInput as Record<string, unknown>;
  if (hasAIReviewedMarker(input, ctx.toolName)) {
    debugLogHookBranch('dangerous-actions', 'ai-reviewed-marker-honored', {
      toolKind: ctx.toolKind,
      toolName: ctx.toolName,
      patternId: pattern?.id ?? null,
      patternLabel: pattern?.label ?? null,
    });
    recordAudit(ctx, 'override', pattern);
    return null;
  }
  debugLogHookBranch('dangerous-actions', 'reconsider-deny', {
    toolKind: ctx.toolKind,
    toolName: ctx.toolName,
    patternId: pattern?.id ?? null,
    patternLabel: pattern?.label ?? null,
  });
  recordAudit(ctx, 'deny', pattern);
  return result;
}
