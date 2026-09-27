// FR-CLI-0074 — lint output formats.

import type { Finding } from './types.js';

/** `file:line: [rule] message`, one per line; empty string when there are no findings. */
export function formatFindingsText(findings: Finding[]): string {
  return findings.map((f) => `${f.file}:${f.line}: [${f.rule}] ${f.message}`).join('\n');
}

/** A single JSON array of findings, pretty-printed. */
export function formatFindingsJson(findings: Finding[]): string {
  return JSON.stringify(findings, null, 2);
}

export type LintFormat = 'text' | 'json';

export function isLintFormat(value: string): value is LintFormat {
  return value === 'text' || value === 'json';
}
