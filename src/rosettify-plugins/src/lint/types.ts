// FR-CLI-0070–0074 — shared types for the deterministic instruction linter.

export type Severity = 'error' | 'warning';

/** One reported lint problem. `line` is 1-based; 0 when the finding is not line-specific. */
export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  message: string;
}

/**
 * One instruction file as resolved for the release/domain/profile being linted: content and
 * frontmatter already reflect directive/overwrite/profile resolution (src/lint/resolve.ts), so a
 * rule never has to reason about `~overwrite~`/`~profile-<name>-only~` tokens itself.
 */
export interface LintFile {
  /** VFS-relative path, e.g. "skills/codemap/SKILL.md" or "agents/architect.md". */
  path: string;
  /** Absolute filesystem path of the resolved source, for display/line attribution. */
  origin: string;
  /** Resolved content: frontmatter + body, LF-normalized, directive tokens stripped from path. */
  content: string;
  frontmatter?: Record<string, unknown>;
}

export type LintRule = (files: LintFile[]) => Finding[];
