// FR-CLI-0073 — known-model-token rule: every candidate in an agent's frontmatter `model:` field
// must name a vendor family the generator's model-maps.ts recognizes.

import {
  CLAUDE_VOCABULARY,
  CODEX_VOCABULARY,
  COPILOT_VOCABULARY,
  CURSOR_VOCABULARY,
  isClaudeCompatibleToken,
  isCodexToken,
} from '../../spec/model-maps.js';
import type { ProfileDescriptor } from '../../spec/profiles.js';
import type { Finding, LintFile } from '../types.js';

const RULE = 'known-model-token';

// Vendor prefixes that appear only as exact CURSOR/COPILOT map keys (gemini-*/grok-*/composer-*)
// have no exported predicate the way Claude/Codex do (isClaudeCompatibleToken/isCodexToken) — the
// prefix itself is the recognition test, mirroring how those two functions work.
const KNOWN_PREFIXES = ['gemini-', 'grok-', 'composer-'];

// `inherit` is a legitimate frontmatter/subagent_required_model value (docs/ARCHITECTURE.md
// "Plugins" — model rewriting), not a vendor token at all.
const KNOWN_LITERALS = new Set(['inherit']);

function builtinKnownTokens(): Set<string> {
  return new Set([
    ...Object.keys(CLAUDE_VOCABULARY.map),
    ...Object.keys(CURSOR_VOCABULARY.map),
    ...Object.keys(COPILOT_VOCABULARY.map),
    ...Object.keys(CODEX_VOCABULARY.map),
  ]);
}

function profileKnownTokens(profile: ProfileDescriptor | null): Set<string> {
  const tokens = new Set<string>();
  if (!profile) return tokens;
  for (const block of Object.values(profile.modelOverrides)) {
    if (!block) continue;
    // core-claude's block is keyed by family (opus/sonnet/haiku), already covered by
    // isClaudeCompatibleToken; cursor/copilot/codex blocks are keyed by exact source token.
    for (const key of Object.keys(block)) tokens.add(key);
  }
  return tokens;
}

function isKnownModelToken(token: string, known: Set<string>): boolean {
  if (KNOWN_LITERALS.has(token)) return true;
  if (known.has(token)) return true;
  if (isClaudeCompatibleToken(token)) return true;
  if (isCodexToken(token)) return true;
  return KNOWN_PREFIXES.some((p) => token.toLowerCase().startsWith(p));
}

function modelLineNumber(file: LintFile): number {
  const idx = file.content.split('\n').findIndex((l) => /^model:\s*/.test(l));
  return idx >= 0 ? idx + 1 : 1;
}

/**
 * FR-CLI-0073: flags a `model:` candidate token that no built-in vocabulary (or, under an active
 * profile, that profile's modelOverrides) recognizes by any of its selection predicates.
 */
export function knownModelTokenRule(files: LintFile[], profile: ProfileDescriptor | null): Finding[] {
  const findings: Finding[] = [];
  const known = new Set([...builtinKnownTokens(), ...profileKnownTokens(profile)]);

  for (const file of files) {
    if (!file.path.startsWith('agents/') || !file.path.endsWith('.md')) continue;
    const modelField = file.frontmatter?.model;
    if (typeof modelField !== 'string') continue;

    const line = modelLineNumber(file);
    for (const rawToken of modelField.split(',')) {
      const token = rawToken.trim();
      if (!token) continue;
      if (isKnownModelToken(token, known)) continue;

      findings.push({
        rule: RULE,
        severity: 'error',
        file: file.path,
        line,
        message: `model token "${token}" is not recognized by any built-in or active-profile model vocabulary.`,
      });
    }
  }

  return findings;
}
