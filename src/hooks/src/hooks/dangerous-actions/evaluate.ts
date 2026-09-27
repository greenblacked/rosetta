// Rosetta-AI-reviewed: pattern definitions only — not executable SQL/shell
import { advise, deny } from '../../runtime/result-helpers';
import { debugLogHookBranch } from '../../runtime/debug-log';
import { appendAuditRecord, type AuditDecision } from '../../runtime/audit';
import {
  getEffectivePatternSets,
  MAX_ORG_MATCH_INPUT_LENGTH,
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
 *  'block'-tier pattern (see evaluateDangerous). Only an org's managed policy can set this
 *  tier; it is never a built-in. */
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

/** ORG-supplied patterns (added, or overriding a built-in id) are only tested against a
 *  bounded prefix of the candidate string — part of F3-3's regex-safety story: a pattern
 *  that was validated at load time (compiled, length-capped, nested-quantifier heuristic)
 *  still gets a bounded worst case at match time. Built-in patterns are untouched — they
 *  already carry their own anti-quadratic invariants and scaling tests (see patterns.ts). */
function testEffective(pattern: EffectivePattern, value: string): boolean {
  const candidate = pattern.source === 'builtin' ? value : value.slice(0, MAX_ORG_MATCH_INPUT_LENGTH);
  return pattern.re.test(candidate);
}

function matchPatterns(
  patterns: readonly EffectivePattern[],
  value: string,
): EffectivePattern | null {
  for (const p of patterns) {
    if (testEffective(p, value)) return p;
  }
  return null;
}

function matchDangerousPath(
  patterns: readonly EffectivePattern[],
  filePath: string,
): EffectivePattern | null {
  // A8: normalize Windows backslashes before the `/`-only trailing-slash strip and split, so
  // `C:\Users\me\.aws\credentials` matches the same as its POSIX form.
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const basename = normalizedPath.split('/').pop() ?? normalizedPath;
  for (const p of patterns) {
    if (testEffective(p, normalizedPath)) return p;
    if (testEffective(p, basename)) return p;
  }
  return null;
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
  const bashPattern = matchPatterns(sets.bash, command);
  if (bashPattern) return { result: buildResultForPattern(bashPattern, toolKind), pattern: bashPattern };

  const contentPattern = matchPatterns(sets.content, command);
  if (contentPattern) return { result: buildResultForPattern(contentPattern, toolKind), pattern: contentPattern };

  return { result: null, pattern: null };
}

function evalBash(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  const command = ctx.toolInput.command;
  if (typeof command !== 'string') return { result: null, pattern: null };
  return evalShellString(command, 'bash', sets);
}

function evalWrite(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  const filePath = ctx.toolInput.file_path;
  if (typeof filePath === 'string') {
    const pattern = matchDangerousPath(sets.paths, filePath);
    if (pattern) return { result: buildResultForPattern(pattern, 'write'), pattern };
  }
  const content = ctx.toolInput.content;
  if (typeof content === 'string') {
    const pattern = matchPatterns(sets.content, content);
    if (pattern) return { result: buildResultForPattern(pattern, 'write'), pattern };
  }
  return { result: null, pattern: null };
}

function evalEdit(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  const filePath = ctx.toolInput.file_path;
  if (typeof filePath === 'string') {
    const pattern = matchDangerousPath(sets.paths, filePath);
    if (pattern) return { result: buildResultForPattern(pattern, 'edit'), pattern };
  }
  const newString = ctx.toolInput.new_string;
  if (typeof newString === 'string') {
    const pattern = matchPatterns(sets.content, newString);
    if (pattern) return { result: buildResultForPattern(pattern, 'edit'), pattern };
  }
  return { result: null, pattern: null };
}

function evalMultiEdit(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  const filePath = ctx.toolInput.file_path;
  if (typeof filePath === 'string') {
    const pattern = matchDangerousPath(sets.paths, filePath);
    if (pattern) return { result: buildResultForPattern(pattern, 'multi-edit'), pattern };
  }
  const edits = ctx.toolInput.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === 'object') {
        const ns = (edit as Record<string, unknown>).new_string;
        if (typeof ns === 'string') {
          const pattern = matchPatterns(sets.content, ns);
          if (pattern) return { result: buildResultForPattern(pattern, 'multi-edit'), pattern };
        }
      }
    }
  }
  return { result: null, pattern: null };
}

function evalMcpCall(ctx: HookContext, sets: EffectivePatternSets): PatternHit {
  const input = ctx.toolInput;

  for (const f of MCP_SHELL_FIELDS) {
    const v = input[f];
    if (typeof v === 'string') {
      const hit = evalShellString(v, ctx.toolName, sets);
      if (hit.pattern) return hit;
    }
  }
  for (const f of MCP_PATH_FIELDS) {
    const v = input[f];
    if (typeof v === 'string') {
      const pattern = matchDangerousPath(sets.paths, v);
      if (pattern) return { result: buildResultForPattern(pattern, ctx.toolName), pattern };
    }
  }
  for (const f of MCP_CONTENT_FIELDS) {
    const v = input[f];
    if (typeof v === 'string') {
      const pattern = matchPatterns(sets.content, v);
      if (pattern) return { result: buildResultForPattern(pattern, ctx.toolName), pattern };
    }
  }
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
 *   - 'block'     → hard-deny: the marker is NEVER consulted. Only reachable through an
 *                   org's managed policy (see runtime/policy.ts) — there is still no
 *                   built-in hard-deny tier, preserving the existing "hook never
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

  // F3-3 'block' tier: org-managed only, never in the built-in pattern sets. Hard-deny —
  // the marker is not even checked, unlike every other tier here.
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
