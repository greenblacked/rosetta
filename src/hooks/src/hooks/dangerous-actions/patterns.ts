// # Rosetta-AI-reviewed: pattern definitions only — not executable SQL/shell
export interface DangerPattern {
  id: string;
  re: RegExp;
  label: string;
  reason: string;
  // 'reconsider' — soft-deny: block THIS attempt and prompt the AI to reconsider.
  //                The AI may still proceed (e.g. the user asked for it) by re-issuing
  //                with the Rosetta-AI-reviewed marker, or stop and ask the user.
  // 'advise'     — non-blocking safety nudge; the action proceeds, the agent is just warned.
  // NOTE: there is intentionally no unconditional-block tier — the hook never hard-denies.
  policy: 'reconsider' | 'advise';
}

/**
 * Static reason taxonomy. Per the review directive the hook never echoes the command
 * or any evidence back — the AI already knows what it ran. It surfaces only a short,
 * generic, PREDEFINED reason. Every pattern selects one of these fixed strings; no
 * per-command text, no interpolation. Keep this set small.
 */
export const REASON = {
  DATA_MANIPULATION:     'unsafe data manipulation',
  SCHEMA_MODIFICATION:   'unsafe schema modification',
  FILE_DELETION:         'irreversible file deletion',
  GIT_HISTORY_REWRITE:   'git history rewrite',
  DEVICE_OPERATION:      'destructive device operation',
  PERMISSION_CHANGE:     'unsafe permission change',
  REMOTE_CODE_EXECUTION: 'remote code execution',
  INFRA_OPERATION:       'unsafe infrastructure operation',
  CREDENTIAL_OVERWRITE:  'credential file overwrite',
} as const;

const SQL_DROP_RE     = /\bdrop\s+(?:table|database|schema)\b/i;
const SQL_TRUNCATE_RE = /\btruncate\s+(?:table\s+)?\w+/i;
// DELETE / UPDATE are destructive only WITHOUT a WHERE clause. The negative
// lookahead `(?![^;]*\bwhere\b)` scans to the end of THIS statement (bounded by
// the next `;`) — so `DELETE FROM a; ... b WHERE …` still flags the unguarded
// first statement, while `DELETE FROM a WHERE …` is left alone.
//
// KNOWN LIMITATIONS (intentional — a correct fix needs a SQL lexer, not a regex,
// which is out of scope here). The WHERE-detection is a flat `\bwhere\b` search
// bounded by the first `;`, so it is blind to SQL structure in two ways:
//
//   (a) `;` inside a string/identifier/comment/dollar-quote. A `;` embedded BEFORE
//       the WHERE (e.g. `UPDATE t SET c = 'a;b' WHERE id = 5`) shortens the scan
//       window so WHERE is not seen and the (safe) statement is flagged. This errs
//       toward a FALSE POSITIVE only — an embedded `;` can never let an unguarded
//       statement through.
//
//   (b) WHERE that does not actually govern the statement — inside a SUBQUERY
//       (`UPDATE t SET x = (SELECT y FROM z WHERE z.id = 1)`) or a COMMENT
//       (`DELETE FROM users -- WHERE never`). Here a WHERE exists in the window but
//       not as the statement's own clause, so the (genuinely destructive) statement
//       is NOT flagged. This is a FALSE NEGATIVE — danger passes. Accepted as a
//       known gap on a `reconsider`-tier guard; see the "known limitation" tests.
//
// Both directions are pinned by characterization tests so a future change is noticed.
//
// SCALING NOTE — this family is the INVERSE of the suffix-window case used by the
// matchers further down. The WHERE guard is a NEGATIVE (not-exists) lookahead, so it
// is ANTI-monotone: a later candidate in the same statement sees a strict SUFFIX of
// the earlier one's window, and "no WHERE in a suffix" is IMPLIED by "no WHERE in the
// whole window" — never the other way round. The BEST candidate is therefore the LAST
// one in the statement, not the first, and anchoring to the first candidate (the shape
// that is correct for every other matcher here) would be a FALSE NEGATIVE bug.
//
// So instead of a segment prefix, a candidate is discarded when another candidate
// follows it inside the same statement: `(?![^;]*?<keyword>)`. That check is
// self-limiting — it stops at the NEXT candidate rather than scanning to the end of
// the statement — so the overlapping-rescan cost disappears while the surviving
// candidate is exactly the last one, which is the one with the widest WHERE window.
// The lazy `*?` is language-identical to a greedy `*` here (both are existence checks)
// and is used only so the scan stops at the first hit instead of backtracking from the
// end of the statement.
//
// FAILURE MODE if this is ever changed: bounding the WHERE lookahead (to a line, or to
// a fixed distance) makes the not-exists guard succeed too often and produces FALSE
// POSITIVES; dropping the "no later candidate" guard restores the quadratic rescan;
// replacing it with a first-candidate prefix produces FALSE NEGATIVES.
// `;` is the ONLY boundary here — `[^;]*` crosses CR/LF deliberately.
const SQL_DELETE_FROM_KEYWORD = String.raw`\bdelete\s+from\b`;
const SQL_DELETE_NO_WHERE_RE   = new RegExp(
  SQL_DELETE_FROM_KEYWORD +
  String.raw`(?![^;]*?${SQL_DELETE_FROM_KEYWORD})(?![^;]*\bwhere\b)`, 'i');
// Same anti-monotone / last-candidate treatment as SQL_DELETE_NO_WHERE_RE above.
// One extra subtlety: this keyword's table operand is `\S+`, which CAN swallow a `;`
// (`UPDATE a;b SET …`). The "no later candidate" guard therefore uses a `;`-free
// variant of the keyword (`[^;\s]+`), so the candidate it hands off to is guaranteed to
// end inside the SAME statement. Using plain `\S+` there would let the guard discard a
// candidate in favour of one whose WHERE window starts past the `;` — a FALSE NEGATIVE
// (`update a set x update b;c set y where z` is the witness: the straddling candidate's
// own WHERE window starts after the `;`, so the guard would hand off to a candidate that
// cannot vouch for the first one's statement).
const SQL_UPDATE_SET_KEYWORD          = String.raw`\bupdate\s+\S+\s+set\b`;
const SQL_UPDATE_SET_KEYWORD_IN_STMT  = String.raw`\bupdate\s+[^;\s]+\s+set\b`;
const SQL_UPDATE_NO_WHERE_RE   = new RegExp(
  SQL_UPDATE_SET_KEYWORD +
  String.raw`(?![^;]*?${SQL_UPDATE_SET_KEYWORD_IN_STMT})(?![^;]*\bwhere\b)`, 'i');
const SQL_DROP_INDEX_VIEW_RE   = /\bdrop\s+(?:index|view)\b/i;
// ALTER … DROP COLUMN within one statement; `[^;]*` keeps the DROP bound to its
// own ALTER TABLE (so an ADD COLUMN in the same statement is not mis-flagged).
//
// Start candidate discovery at a statement boundary and stop the prefix at the FIRST
// `ALTER TABLE` in that statement. `;` is the ONLY boundary here — `[^;]*` crosses
// CR/LF deliberately, so line breaks must NOT be added to the class. The DROP COLUMN
// search is an unbounded existential scan to the next `;`, so every later ALTER TABLE
// in the same statement sees a strict SUFFIX of the first one's window: whatever a
// later candidate can see, the first candidate can see too.
// FAILURE MODE if this is ever changed: bounding that scan (to a line, or to a fixed
// distance) breaks the suffix relation and turns this into FALSE NEGATIVES for a DROP
// COLUMN that sits far from its ALTER TABLE.
const SQL_ALTER_TABLE_KEYWORD  = String.raw`\balter\s+table\b`;
const SQL_ALTER_TABLE_STATEMENT =
  String.raw`(?:^|;)(?:(?!${SQL_ALTER_TABLE_KEYWORD})[^;])*${SQL_ALTER_TABLE_KEYWORD}`;
const SQL_ALTER_DROP_COLUMN_RE = new RegExp(
  SQL_ALTER_TABLE_STATEMENT + String.raw`[^;]*\bdrop\s+column\b`, 'i');

// `rm` recursive + force detection. GNU getopt permutes options past operands,
// so the recursive flag (-r/-R/--recursive) and the force flag (-f/--force) may
// appear combined (-rf), separate, in any order, at any distance, and on either
// side of the target path. We require BOTH a recursive marker AND a force marker
// somewhere in the command. Each flag token is anchored to a preceding whitespace
// OR quote (`'`/`"`): the quote covers `rm "-rf" /` (the shell strips quotes and
// passes `-rf` to rm), while still treating a dash inside a path like ./my-file —
// preceded by a letter — as part of the name, not a flag.
const RM_RECURSIVE_LA = String.raw`(?=.*(?:\s|['"])(?:--recursive\b|-[a-zA-Z]*[rR]))`;
const RM_FORCE_LA     = String.raw`(?=.*(?:\s|['"])(?:--force\b|-[a-zA-Z]*f))`;
const RM_RF_GUARD     = RM_RECURSIVE_LA + RM_FORCE_LA;
// A root operand: a standalone `/` (or `/*`), i.e. a slash followed by space/end/`*`.
const RM_ROOT_TARGET  = String.raw`.*\s\/(?:\*|\s|$)`;
const RM_HOME_TARGET  = String.raw`.*\s(?:~(?:\/|\s|$)|\$HOME\b)`;
// Both flag lookaheads and both target scans above use unbounded `.`-windows that run
// to the end of the line, so every later `rm` on the same line sees a strict SUFFIX of
// the first one's window — see `firstOnLine` below for the invariant and its failure
// mode. `rm` is a single token, so no gap can straddle a line break and no cross-line
// alternative is needed. NOTE: `;`, `&&` and `|` are NOT boundaries for these windows
// and never were — `rm -r a; -f b` matches today and must keep matching.

// `git push` force detection. Two independent force mechanisms:
//   (a) an explicit force flag — `-f` or `--force` — but NOT the safer
//       `--force-with-lease`, which is intentionally treated as non-destructive.
//   (b) force-by-refspec — a refspec whose first character is `+`
//       (e.g. `git push origin +main`), which git treats as an unconditional force.
const GIT_PUSH = String.raw`\bgit\s+push\b`;
const GIT_FORCE_FLAG_LA = String.raw`(?=(?:\s+\S+)*\s+(?:-f\b|--force(?!-with-lease)))`;
// The `+` must START a refspec token, so it is anchored to a preceding space or
// quote (`'`/`"`). This deliberately excludes: a `+` inside a branch name
// (`feature+x` — preceded by a letter), a `+` after a colon (`src:+dst` — the
// force `+` is only recognised at the very start of a refspec), and a backtick
// (`` `+main` `` is command substitution, not a quoted literal). The `+`-refspec
// must also be preceded by the repository operand — `(?!-)(?!['"]?\+)\S+` matches
// that repository — so a bare `git push +main` (where `+main` IS the repository
// argument, not a refspec) is left alone and handled separately.
const GIT_FORCE_REFSPEC_LA = String.raw`(?=(?:\s+-\S+)*\s+(?!-)(?!['"]?\+)\S+(?:\s+\S+)*\s+['"]?\+\S)`;

// SCALING — `git push` needs a DIFFERENT treatment from every other matcher here, and
// the difference is worth spelling out because the obvious fix is wrong.
//
// 1. There is NO segment boundary. Both lookaheads are built out of `\s`, which matches
//    CR and LF, and neither is bounded by `;`, `&&` or `|`. The window of a candidate is
//    therefore the WHOLE REST OF THE INPUT — `git push a; echo --force` matches today
//    and must keep matching. That also means there is no cross-line case to carve out:
//    a line break is just another `\s`, so `^` (this RegExp has no `m` flag) is the only
//    segment start there is.
//
// 2. The two lookaheads do NOT share a monotonicity property, so they cannot share one
//    prefix.
//    * The FLAG lookahead is a plain existential — "some later whitespace-delimited
//      token starts with -f / --force" — so a later candidate's window is a strict
//      SUFFIX of an earlier candidate's window and the FIRST candidate sees everything.
//      The one precondition is that the candidate is followed by whitespace: both
//      lookaheads open with `\s+`, so a candidate that is not (e.g. `git push;…`) can
//      never match and must be skipped rather than anchored to — otherwise
//      `git push;git push --force` becomes a FALSE NEGATIVE.
//    * The REFSPEC lookahead is NOT existential. It pins the repository operand to the
//      FIRST non-flag token after `git push` and then requires `(?!['"]?\+)` of it. That
//      guard can fail for an early candidate and hold for a later one, so the suffix
//      relation breaks: `git push +foo git push origin +main` matches today, but only at
//      the SECOND candidate. Anchoring both branches to one shared first candidate
//      silently drops it.
//
// So each branch gets its own prefix, each anchored to the first candidate that its own
// branch could possibly satisfy. Among refspec-viable candidates the lookahead IS
// monotone again — the repository operand of an earlier viable candidate sits at or
// before that of a later one, and the `+`-refspec witness lies after both — so the first
// viable candidate is sufficient.
//
// FAILURE MODE if this is ever changed: merging the two prefixes, dropping `(?=\s)` from
// the flag head, dropping the `(?!['"]?\+)` guard from the refspec head, or bounding
// either lookahead to a scan distance or a shell separator all produce FALSE NEGATIVES.
// Each of those four is pinned by a test below.
const GIT_PUSH_FLAG_HEAD    = String.raw`${GIT_PUSH}(?=\s)`;
const GIT_PUSH_REFSPEC_HEAD = String.raw`${GIT_PUSH}(?=(?:\s+-\S+)*\s+(?!-)(?!['"]?\+)\S)`;
const firstInInput = (head: string): string =>
  String.raw`^(?:(?!${head})[\s\S])*${head}`;

// `git branch` force-delete detection. `-D` is shorthand for `--delete --force`.
// Git also accepts delete + force as separate short/long flags, in either order,
// and as combined short flags (`-df` / `-fd`). Keep the delete and force checks
// independent so ordinary `-d` / `--delete` remains outside this guardrail.
// Lookaheads stop at common shell command separators so a later command cannot
// accidentally supply the missing force/delete flag for an earlier branch command.
// Start local-command matching at a segment boundary and stop the prefix at its
// first `git branch`. Both lookaheads below scan unbounded to the segment end, so
// every later candidate's window is a suffix of the first candidate's window:
// any delete/force pair visible later is visible from the first candidate too.
// Bounding either lookahead would invalidate this optimization and risk false
// negatives.
const GIT_BRANCH_LOCAL = String.raw`\bgit[^\S\r\n]+branch\b`;
const GIT_BRANCH_SEGMENT_PREFIX = String.raw`(?:^|[;&|\r\n])(?:(?!${GIT_BRANCH_LOCAL})[^;&|\r\n])*`;
// CR/LF must remain segment boundaries. This RegExp has no `m` flag, so `^` only
// matches the input start; without explicit line separators the prefix cannot
// begin after a line boundary.
// Preserve the prior `\s+` behavior when `git` and `branch` straddle CR/LF. Such
// candidates necessarily cross a separator, so their lookahead windows stay bounded.
const GIT_BRANCH_CROSS_LINE = String.raw`\bgit[^\S\r\n]*[\r\n]\s*branch\b`;
const GIT_BRANCH = String.raw`(?:${GIT_BRANCH_SEGMENT_PREFIX}${GIT_BRANCH_LOCAL}|${GIT_BRANCH_CROSS_LINE})`;
const GIT_BRANCH_DELETE_LA = String.raw`(?=[^;&|\r\n]*(?:\s--delete\b|\s-[a-zA-Z]*[dD][a-zA-Z]*\b))`;
const GIT_BRANCH_FORCE_LA = String.raw`(?=[^;&|\r\n]*(?:\s--force\b|\s-[a-zA-Z]*[fD][a-zA-Z]*\b))`;

// ---------------------------------------------------------------------------
// Segment anchoring for `.`-window matchers.
//
// JS `.` (no `s` flag) matches every character EXCEPT these four, so any `.`-based
// scan or lookahead window ends exactly at the next one of them. They are therefore
// the ONLY segment boundaries for the matchers below. `;`, `&&` and `|` are
// deliberately NOT boundaries here: the pre-existing matchers never treated them as
// such, and narrowing the window to shell command separators would be a policy
// change (new false negatives), not the matcher-shape change intended here.
// U+2028/U+2029 must stay in the class: omitting them lets the prefix run past a
// boundary that `.` cannot cross, which reintroduces false negatives.
const LINE_BREAK_CLASS = String.raw`\r\n\u2028\u2029`;
const LINE_START       = String.raw`(?:^|[${LINE_BREAK_CLASS}])`;
// Whitespace that is NOT a line break — used to keep a multi-token keyword line-local.
const INLINE_SPACE     = String.raw`[^\S${LINE_BREAK_CLASS}]`;

/**
 * Start candidate discovery at a line boundary and stop the prefix at the FIRST
 * line-local occurrence of `keyword` on that line.
 *
 * INVARIANT (why this is sound): every predicate applied after the keyword is an
 * EXISTENTIAL check over an UNBOUNDED `.`-window that runs to the end of the line.
 * A later candidate on the same line therefore sees a window that is a strict SUFFIX
 * of the first candidate's window, so anything a later candidate can see the first
 * candidate can see too. Trying only the first candidate per line loses nothing.
 *
 * FAILURE MODE if this is ever changed: bounding any of those lookaheads to a fixed
 * scan distance (or to `;`/`&&`/`|`) destroys the suffix-window relation and turns
 * this optimization into FALSE NEGATIVES — a qualifying flag that sits far from the
 * keyword, or past a `;`, would stop being seen. Keep the windows unbounded.
 */
const firstOnLine = (keyword: string): string =>
  String.raw`${LINE_START}(?:(?!${keyword}).)*${keyword}`;

// `aws s3 rm --recursive`. `--recursive` is found by an unbounded `.`-window, so the
// suffix-window invariant above applies to the two `aws`/`s3`/`rm` gaps.
// CR/LF/U+2028/U+2029 must remain segment boundaries: this RegExp has no `m` flag, so
// `^` only matches the input start; without the explicit line-separator class the
// prefix could not begin after a line boundary.
const AWS_S3_RM_LOCAL = String.raw`\baws${INLINE_SPACE}+s3${INLINE_SPACE}+rm\b`;
// Preserve the prior `\s+` behavior when a gap straddles a line break (either gap).
// Such candidates necessarily cross a boundary, so their windows stay bounded and
// cannot recreate the overlapping rescan.
const AWS_S3_RM_CROSS_LINE = String.raw`(?:\baws${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*s3\s+rm\b|\baws${INLINE_SPACE}+s3${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*rm\b)`;
const AWS_S3_RM = String.raw`(?:${firstOnLine(AWS_S3_RM_LOCAL)}|${AWS_S3_RM_CROSS_LINE})`;

// `kubectl delete --all`. `--all` is found by an unbounded `.`-window; same
// suffix-window invariant and same cross-line carve-out as AWS_S3_RM above.
const KUBECTL_DELETE_LOCAL = String.raw`\bkubectl${INLINE_SPACE}+delete\b`;
const KUBECTL_DELETE_CROSS_LINE = String.raw`\bkubectl${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*delete\b`;
const KUBECTL_DELETE = String.raw`(?:${firstOnLine(KUBECTL_DELETE_LOCAL)}|${KUBECTL_DELETE_CROSS_LINE})`;

// `dd of=/dev/…`. `of=/dev/` is found by an unbounded `.`-window; same suffix-window
// invariant as above. `dd` is a single token with no internal whitespace, so — unlike
// `aws s3 rm` or `kubectl delete` — there is no gap that could straddle a line break
// and therefore no cross-line alternative to preserve.
const DD_LOCAL = String.raw`\bdd\b`;
const DD = firstOnLine(DD_LOCAL);

// `curl … | sh`. The pipe-to-shell tail is found by an unbounded `.`-window, so the
// same suffix-window invariant applies. The single `\s` that the original required
// right after `curl` is split into its line-local half (which keeps the candidate on
// one line) and its line-break half (the cross-line alternative); the two halves are
// disjoint and their union is exactly `\s`, so the accepted keyword set is unchanged.
const CURL_LOCAL = String.raw`\bcurl${INLINE_SPACE}`;
const CURL_CROSS_LINE = String.raw`\bcurl[${LINE_BREAK_CLASS}]`;
const CURL = String.raw`(?:${firstOnLine(CURL_LOCAL)}|${CURL_CROSS_LINE})`;

const RM = firstOnLine(String.raw`\brm\b`);

// `psql … DROP TABLE`. Unlike the matchers above, this window is bounded by a QUOTE
// (`"` or `'`), not by a line break — `[^"']*` happily crosses CR/LF — so the segment
// here is the quote-free run, and quotes are its only boundaries. `psql` is a single
// token, so there is no gap to straddle and no cross-line alternative is needed.
// Same suffix-window invariant: the DROP search is an unbounded existential scan to
// the next quote, so a later `psql` in the same quote-free run sees a strict suffix of
// the first one's window. Bounding that scan (e.g. to a line) would produce FALSE
// NEGATIVES for a DROP that sits far from the `psql` token.
const PSQL_SEGMENT = String.raw`(?:^|["'])(?:(?!\bpsql\b)[^"'])*\bpsql\b`;

// ---------------------------------------------------------------------------
// IaC / cloud / data-store patterns (F3-2).
//
// Fixed multi-word command sequences below use a plain `\s+` concatenation,
// exactly like `git-reset-hard` / `chmod-777-recursive` / `mkfs` above: the
// keyword tokens are adjacent with no unbounded `.`-window in between, so
// there is no suffix-window concern and no scaling risk. Only patterns that
// must find a FLAG separated from its keyword by a variable amount of other
// arguments reuse the `firstOnLine`/cross-line treatment established above —
// same suffix-window invariant, same failure mode if the window is ever
// bounded (see the comments on `firstOnLine`, `AWS_S3_RM`, `KUBECTL_DELETE`).

// `terraform`/`tofu apply` with `-auto-approve` or `-destroy`. The flag can
// sit after other apply args (`-var`, `-var-file`, a saved plan file, …), so
// this needs the unbounded `.`-window + cross-line treatment. A plain
// `terraform apply` (interactive, no flag) intentionally does NOT match.
const TF_APPLY_LOCAL = String.raw`\b(?:terraform|tofu)${INLINE_SPACE}+apply\b`;
const TF_APPLY_CROSS_LINE = String.raw`\b(?:terraform|tofu)${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*apply\b`;
const TF_APPLY = String.raw`(?:${firstOnLine(TF_APPLY_LOCAL)}|${TF_APPLY_CROSS_LINE})`;
const TF_APPLY_UNATTENDED_RE = new RegExp(
  TF_APPLY + String.raw`.*(?:-{1,2}auto-approve\b|-destroy\b)`);

// `kubectl delete` against `--all` or a cluster/namespace-scoped resource
// kind (`ns`/`namespace`/`pv`/`pvc`/`crd`). Extends the pre-existing
// `kubectl-delete-prod` pattern (previously `--all` only; id kept stable —
// see DANGEROUS_BASH below) with a resource-kind check. The resource kind
// must NOT be immediately preceded by `-`, so a flag VALUE like
// `--namespace=prod` is never mistaken for the positional `namespace`
// resource kind — `kubectl delete pod x --namespace=prod` (single-pod
// delete) must stay unflagged.
const KUBECTL_DELETE_RESOURCE_RE = String.raw`(?<!-)\b(?:ns|namespace|pv|pvc|crd)\b`;
const KUBECTL_DELETE_CRITICAL_RE = new RegExp(
  KUBECTL_DELETE + String.raw`.*(?:--all\b|${KUBECTL_DELETE_RESOURCE_RE})`);

// `kubectl replace --force`. Same unbounded-window treatment: `--force` can
// follow `-f`/other flags in any order.
const KUBECTL_REPLACE_LOCAL = String.raw`\bkubectl${INLINE_SPACE}+replace\b`;
const KUBECTL_REPLACE_CROSS_LINE = String.raw`\bkubectl${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*replace\b`;
const KUBECTL_REPLACE = String.raw`(?:${firstOnLine(KUBECTL_REPLACE_LOCAL)}|${KUBECTL_REPLACE_CROSS_LINE})`;
const KUBECTL_REPLACE_FORCE_RE = new RegExp(KUBECTL_REPLACE + String.raw`.*--force\b`);

// `gcloud storage rm -r` / `gsutil rm -r`. Same recursive-flag scan as
// AWS_S3_RM: a single file/object delete (no `-r`) is left alone.
const GCLOUD_STORAGE_RM_LOCAL = String.raw`\b(?:gcloud${INLINE_SPACE}+storage${INLINE_SPACE}+rm|gsutil${INLINE_SPACE}+rm)\b`;
const GCLOUD_STORAGE_RM_CROSS_LINE = String.raw`(?:\bgcloud${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*storage\s+rm\b|\bgcloud${INLINE_SPACE}+storage${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*rm\b|\bgsutil${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*rm\b)`;
const GCLOUD_STORAGE_RM = String.raw`(?:${firstOnLine(GCLOUD_STORAGE_RM_LOCAL)}|${GCLOUD_STORAGE_RM_CROSS_LINE})`;
const GCLOUD_STORAGE_RM_RECURSIVE_RE = new RegExp(
  GCLOUD_STORAGE_RM + String.raw`.*(?:\s|['"])(?:--recursive\b|-[rR]\b)`);

// `aws s3 rb --force`. Same unbounded-window flag scan.
const AWS_S3_RB_LOCAL = String.raw`\baws${INLINE_SPACE}+s3${INLINE_SPACE}+rb\b`;
const AWS_S3_RB_CROSS_LINE = String.raw`(?:\baws${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*s3\s+rb\b|\baws${INLINE_SPACE}+s3${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*rb\b)`;
const AWS_S3_RB = String.raw`(?:${firstOnLine(AWS_S3_RB_LOCAL)}|${AWS_S3_RB_CROSS_LINE})`;
const AWS_S3_RB_FORCE_RE = new RegExp(AWS_S3_RB + String.raw`.*--force\b`);

// `docker system prune -a`. Same unbounded-window flag scan; a plain
// `docker system prune` (no `-a`/`--all`) intentionally does NOT match.
const DOCKER_SYSTEM_PRUNE_LOCAL = String.raw`\bdocker${INLINE_SPACE}+system${INLINE_SPACE}+prune\b`;
const DOCKER_SYSTEM_PRUNE_CROSS_LINE = String.raw`(?:\bdocker${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*system\s+prune\b|\bdocker${INLINE_SPACE}+system${INLINE_SPACE}*[${LINE_BREAK_CLASS}]\s*prune\b)`;
const DOCKER_SYSTEM_PRUNE = String.raw`(?:${firstOnLine(DOCKER_SYSTEM_PRUNE_LOCAL)}|${DOCKER_SYSTEM_PRUNE_CROSS_LINE})`;
const DOCKER_SYSTEM_PRUNE_ALL_RE = new RegExp(
  DOCKER_SYSTEM_PRUNE + String.raw`.*(?:\s|['"])(?:--all\b|-a\b)`);

// `redis-cli … FLUSHALL|FLUSHDB`. Host/port/auth args can precede the
// command, so this reuses the single-token `firstOnLine` treatment (like DD).
const REDIS_CLI = firstOnLine(String.raw`\bredis-cli\b`);
const REDIS_FLUSH_RE = new RegExp(REDIS_CLI + String.raw`.*\bflush(?:all|db)\b`, 'i');

// Fixed-sequence patterns: keyword tokens are adjacent, no window needed.
const TF_DESTROY_RE                       = /\b(?:terraform|tofu)\s+destroy\b/;
const TF_STATE_RM_RE                      = /\b(?:terraform|tofu)\s+state\s+rm\b/;
const TF_WORKSPACE_DELETE_RE              = /\b(?:terraform|tofu)\s+workspace\s+delete\b/;
const TF_FORCE_UNLOCK_RE                  = /\b(?:terraform|tofu)\s+force-unlock\b/;
const HELM_UNINSTALL_RE                   = /\bhelm\s+(?:uninstall|delete)\b/;
const KUBECTL_DRAIN_RE                    = /\bkubectl\s+drain\b/;
const PULUMI_DESTROY_RE                   = /\bpulumi\s+destroy\b/;
const PULUMI_STACK_RM_RE                  = /\bpulumi\s+stack\s+rm\b/;
const GCLOUD_PROJECTS_DELETE_RE           = /\bgcloud\s+projects\s+delete\b/;
const GCLOUD_SQL_INSTANCES_DELETE_RE      = /\bgcloud\s+sql\s+instances\s+delete\b/;
const GCLOUD_CONTAINER_CLUSTERS_DELETE_RE = /\bgcloud\s+container\s+clusters\s+delete\b/;
const GCLOUD_COMPUTE_INSTANCES_DELETE_RE  = /\bgcloud\s+compute\s+instances\s+delete\b/;
const AWS_RDS_DELETE_RE                   = /\baws\s+rds\s+delete-db-(?:instance|cluster)\b/;
const AWS_EC2_TERMINATE_RE                = /\baws\s+ec2\s+terminate-instances\b/;
const AWS_CFN_DELETE_STACK_RE             = /\baws\s+cloudformation\s+delete-stack\b/;
const AWS_EKS_DELETE_CLUSTER_RE           = /\baws\s+eks\s+delete-cluster\b/;
const AWS_DYNAMODB_DELETE_TABLE_RE        = /\baws\s+dynamodb\s+delete-table\b/;
const AZ_GROUP_DELETE_RE                  = /\baz\s+group\s+delete\b/;
const AZ_AKS_DELETE_RE                    = /\baz\s+aks\s+delete\b/;
const AZ_SQL_DB_DELETE_RE                 = /\baz\s+sql\s+db\s+delete\b/;
// `db.dropDatabase()` / `dropDatabase()` (mongo/mongosh shell or driver call).
// No receiver-identifier requirement, so `db.dropDatabase()` and a bare
// `dropDatabase()` both match; the mandatory `(` immediately (mod whitespace)
// after the name excludes an unrelated identifier like `dropDatabaseBackup()`.
const MONGO_DROP_DATABASE_RE              = /\bdropDatabase\s*\(/i;
const DOCKER_VOLUME_PRUNE_RE              = /\bdocker\s+volume\s+prune\b/;
const GH_REPO_DELETE_RE                   = /\bgh\s+repo\s+delete\b/;

export const DANGEROUS_BASH: readonly DangerPattern[] = [
  { id: 'rm-rf-root',          re: new RegExp(RM + RM_RF_GUARD + RM_ROOT_TARGET),                              label: 'rm -rf /',              reason: REASON.FILE_DELETION,         policy: 'reconsider' },
  { id: 'rm-rf-home',          re: new RegExp(RM + RM_RF_GUARD + RM_HOME_TARGET),                              label: 'rm -rf $HOME',          reason: REASON.FILE_DELETION,         policy: 'reconsider' },
  { id: 'rm-rf-recursive',     re: new RegExp(RM + RM_RF_GUARD),                                               label: 'rm -rf (generic)',      reason: REASON.FILE_DELETION,         policy: 'reconsider' },
  { id: 'sql-drop-table',      re: SQL_DROP_RE,                                                                label: 'DDL DROP',              reason: REASON.SCHEMA_MODIFICATION,   policy: 'reconsider' },
  { id: 'sql-truncate',        re: SQL_TRUNCATE_RE,                                                            label: 'TRUNCATE TABLE',        reason: REASON.DATA_MANIPULATION,     policy: 'reconsider' },
  { id: 'sql-delete-no-where', re: SQL_DELETE_NO_WHERE_RE,                                                     label: 'DELETE without WHERE',  reason: REASON.DATA_MANIPULATION,     policy: 'reconsider' },
  { id: 'sql-update-no-where', re: SQL_UPDATE_NO_WHERE_RE,                                                     label: 'UPDATE without WHERE',  reason: REASON.DATA_MANIPULATION,     policy: 'reconsider' },
  { id: 'sql-drop-index-view', re: SQL_DROP_INDEX_VIEW_RE,                                                     label: 'DROP INDEX/VIEW',       reason: REASON.SCHEMA_MODIFICATION,   policy: 'reconsider' },
  { id: 'sql-alter-drop-col',  re: SQL_ALTER_DROP_COLUMN_RE,                                                   label: 'ALTER DROP COLUMN',     reason: REASON.SCHEMA_MODIFICATION,   policy: 'reconsider' },
  { id: 'git-force-push',      re: new RegExp(
      `${firstInInput(GIT_PUSH_FLAG_HEAD)}${GIT_FORCE_FLAG_LA}` +
      `|${firstInInput(GIT_PUSH_REFSPEC_HEAD)}${GIT_FORCE_REFSPEC_LA}`),               label: 'git push --force',      reason: REASON.GIT_HISTORY_REWRITE,   policy: 'reconsider' },
  { id: 'git-reset-hard',      re: /\bgit\s+reset\s+--hard\b/,                                                 label: 'git reset --hard',      reason: REASON.GIT_HISTORY_REWRITE,   policy: 'reconsider' },
  { id: 'git-clean-force',     re: /\bgit\s+clean\s+-[a-z]*[fd]/,                                              label: 'git clean -fd',         reason: REASON.FILE_DELETION,         policy: 'reconsider' },
  { id: 'git-branch-delete',   re: new RegExp(GIT_BRANCH + GIT_BRANCH_DELETE_LA + GIT_BRANCH_FORCE_LA),         label: 'git branch -D',         reason: REASON.GIT_HISTORY_REWRITE,   policy: 'reconsider' },
  { id: 'aws-s3-rm-recursive', re: new RegExp(AWS_S3_RM + String.raw`.*--recursive\b`),                        label: 'aws s3 rm --recursive', reason: REASON.FILE_DELETION,         policy: 'reconsider' },
  // NOTE: id kept stable (was `--all`-only; F3-2 broadened it to also cover
  // `ns`/`namespace`/`pv`/`pvc`/`crd` — see KUBECTL_DELETE_CRITICAL_RE above).
  { id: 'kubectl-delete-prod', re: KUBECTL_DELETE_CRITICAL_RE,                                                 label: 'kubectl critical-resource delete', reason: REASON.INFRA_OPERATION, policy: 'reconsider' },
  { id: 'dropdb',              re: new RegExp(String.raw`(?:\bdropdb\b|${PSQL_SEGMENT}[^"']*\bdrop\s+(?:table|database|schema)\b)`, 'i'), label: 'DB drop CLI', reason: REASON.SCHEMA_MODIFICATION, policy: 'reconsider' },
  { id: 'mkfs',                re: /\bmkfs(?:\.\w+)?\b/,                                                       label: 'filesystem format',     reason: REASON.DEVICE_OPERATION,      policy: 'reconsider' },
  { id: 'dd-of-dev',           re: new RegExp(DD + String.raw`.*\bof=\/dev\/`),                                label: 'dd to device',          reason: REASON.DEVICE_OPERATION,      policy: 'reconsider' },
  { id: 'chmod-777-recursive', re: /\bchmod\s+-R\s+0?777\b/,                                                   label: 'chmod -R 777',          reason: REASON.PERMISSION_CHANGE,     policy: 'reconsider' },
  { id: 'curl-pipe-shell',     re: new RegExp(CURL + String.raw`.*\s\|\s*(?:sh|bash)\b`),                      label: 'curl | sh',             reason: REASON.REMOTE_CODE_EXECUTION, policy: 'reconsider' },

  // --- F3-2: IaC / cloud / data-store dangerous-action pattern pack ---
  { id: 'terraform-destroy',            re: TF_DESTROY_RE,                  label: 'terraform/tofu destroy',            reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'terraform-apply-unattended',   re: TF_APPLY_UNATTENDED_RE,         label: 'terraform/tofu apply -auto-approve/-destroy', reason: REASON.INFRA_OPERATION, policy: 'reconsider' },
  { id: 'terraform-state-rm',           re: TF_STATE_RM_RE,                 label: 'terraform/tofu state rm',           reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'terraform-workspace-delete',   re: TF_WORKSPACE_DELETE_RE,         label: 'terraform/tofu workspace delete',   reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'terraform-force-unlock',       re: TF_FORCE_UNLOCK_RE,             label: 'terraform/tofu force-unlock',       reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'helm-uninstall',               re: HELM_UNINSTALL_RE,              label: 'helm uninstall/delete',             reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'kubectl-drain',                re: KUBECTL_DRAIN_RE,               label: 'kubectl drain',                     reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'kubectl-replace-force',        re: KUBECTL_REPLACE_FORCE_RE,       label: 'kubectl replace --force',           reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'pulumi-destroy',               re: PULUMI_DESTROY_RE,              label: 'pulumi destroy',                    reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'pulumi-stack-rm',              re: PULUMI_STACK_RM_RE,             label: 'pulumi stack rm',                   reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'gcloud-projects-delete',       re: GCLOUD_PROJECTS_DELETE_RE,      label: 'gcloud projects delete',            reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'gcloud-sql-instances-delete',  re: GCLOUD_SQL_INSTANCES_DELETE_RE, label: 'gcloud sql instances delete',       reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'gcloud-container-clusters-delete', re: GCLOUD_CONTAINER_CLUSTERS_DELETE_RE, label: 'gcloud container clusters delete', reason: REASON.INFRA_OPERATION, policy: 'reconsider' },
  { id: 'gcloud-compute-instances-delete',  re: GCLOUD_COMPUTE_INSTANCES_DELETE_RE,  label: 'gcloud compute instances delete',  reason: REASON.INFRA_OPERATION, policy: 'reconsider' },
  { id: 'gcloud-storage-rm-recursive',  re: GCLOUD_STORAGE_RM_RECURSIVE_RE, label: 'gcloud storage/gsutil rm -r',       reason: REASON.FILE_DELETION,       policy: 'reconsider' },
  { id: 'aws-rds-delete',               re: AWS_RDS_DELETE_RE,              label: 'aws rds delete-db-instance/cluster', reason: REASON.INFRA_OPERATION,    policy: 'reconsider' },
  { id: 'aws-ec2-terminate-instances',  re: AWS_EC2_TERMINATE_RE,           label: 'aws ec2 terminate-instances',       reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'aws-cloudformation-delete-stack', re: AWS_CFN_DELETE_STACK_RE,     label: 'aws cloudformation delete-stack',   reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'aws-eks-delete-cluster',       re: AWS_EKS_DELETE_CLUSTER_RE,      label: 'aws eks delete-cluster',            reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'aws-dynamodb-delete-table',    re: AWS_DYNAMODB_DELETE_TABLE_RE,   label: 'aws dynamodb delete-table',         reason: REASON.SCHEMA_MODIFICATION, policy: 'reconsider' },
  { id: 'aws-s3-rb-force',              re: AWS_S3_RB_FORCE_RE,             label: 'aws s3 rb --force',                 reason: REASON.FILE_DELETION,       policy: 'reconsider' },
  { id: 'az-group-delete',              re: AZ_GROUP_DELETE_RE,             label: 'az group delete',                   reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'az-aks-delete',                re: AZ_AKS_DELETE_RE,               label: 'az aks delete',                     reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'az-sql-db-delete',             re: AZ_SQL_DB_DELETE_RE,            label: 'az sql db delete',                  reason: REASON.SCHEMA_MODIFICATION, policy: 'reconsider' },
  { id: 'redis-flushall',               re: REDIS_FLUSH_RE,                 label: 'redis-cli FLUSHALL/FLUSHDB',        reason: REASON.DATA_MANIPULATION,   policy: 'reconsider' },
  { id: 'mongo-drop-database',          re: MONGO_DROP_DATABASE_RE,         label: 'mongo dropDatabase()',              reason: REASON.SCHEMA_MODIFICATION, policy: 'reconsider' },
  { id: 'docker-system-prune-all',      re: DOCKER_SYSTEM_PRUNE_ALL_RE,     label: 'docker system prune -a',            reason: REASON.FILE_DELETION,       policy: 'reconsider' },
  { id: 'docker-volume-prune',          re: DOCKER_VOLUME_PRUNE_RE,         label: 'docker volume prune',               reason: REASON.FILE_DELETION,       policy: 'reconsider' },
  { id: 'gh-repo-delete',               re: GH_REPO_DELETE_RE,              label: 'gh repo delete',                    reason: REASON.FILE_DELETION,       policy: 'reconsider' },
] as const;

// Irreversible key/credential files. These are NOT about secrecy (Rosetta does not
// police what the user keeps in their own files) — they are flagged purely because an
// AI overwriting one of these clobbers a file that cannot be recovered (a private key,
// a credential store), the same data-loss class as `rm -rf` or `git reset --hard`.
// Hence policy 'advise': a non-blocking heads-up, never a block. Normal working files
// like `.env` are intentionally NOT listed — writing them is ordinary development.
// `~/.gnupg/*.key`. The `.key` search is an unbounded `.`-window, so this entry has
// the same suffix-window invariant as the command matchers above: a later `/.gnupg/`
// on the same line sees a strict suffix of the first one's window. Discovery is
// anchored to the first `/.gnupg/` per line; the literal `private-keys-v1.d/`
// alternative needs no anchoring. `/.gnupg/` has no internal whitespace, so no gap can
// straddle a line break and no cross-line alternative is needed.
// FAILURE MODE if this is ever changed: bounding the `.key` scan produces FALSE
// NEGATIVES for a key file nested deeper under `.gnupg/`.
const GNUPG_DIR = String.raw`\/\.gnupg\/`;
const GPG_PRIVATE_RE = new RegExp(
  String.raw`(?:${firstOnLine(GNUPG_DIR)}.*\.key|${GNUPG_DIR}private-keys-v1\.d\/)`);

export const DANGEROUS_PATHS: readonly DangerPattern[] = [
  { id: 'ssh-private-key',  re: /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)$/,                        label: 'SSH private key',  reason: REASON.CREDENTIAL_OVERWRITE, policy: 'advise' },
  { id: 'aws-credentials',  re: /\/\.aws\/(?:credentials|config)/,                                label: 'AWS credentials',  reason: REASON.CREDENTIAL_OVERWRITE, policy: 'advise' },
  { id: 'gcp-credentials',  re: /(?:application_default_credentials\.json|\/\.config\/gcloud\/)/, label: 'GCP credentials',  reason: REASON.CREDENTIAL_OVERWRITE, policy: 'advise' },
  { id: 'kube-config',      re: /\/\.kube\/config$/,                                              label: 'kubeconfig',       reason: REASON.CREDENTIAL_OVERWRITE, policy: 'advise' },
  { id: 'netrc',            re: /^[._]netrc$/,                                                    label: 'netrc',            reason: REASON.CREDENTIAL_OVERWRITE, policy: 'advise' },
  { id: 'pgpass',           re: /^\.pgpass$/,                                                     label: 'Postgres .pgpass', reason: REASON.CREDENTIAL_OVERWRITE, policy: 'advise' },
  { id: 'gpg-private',      re: GPG_PRIVATE_RE,                                                   label: 'GPG private key',  reason: REASON.CREDENTIAL_OVERWRITE, policy: 'advise' },
] as const;

export const DANGEROUS_CONTENT: readonly DangerPattern[] = [
  { id: 'content-sql-drop-table',      re: SQL_DROP_RE,              label: 'DROP in payload',                 reason: REASON.SCHEMA_MODIFICATION, policy: 'reconsider' },
  { id: 'content-sql-truncate',        re: SQL_TRUNCATE_RE,          label: 'TRUNCATE in payload',             reason: REASON.DATA_MANIPULATION,   policy: 'reconsider' },
  { id: 'content-sql-delete-no-where', re: SQL_DELETE_NO_WHERE_RE,   label: 'DELETE without WHERE in payload', reason: REASON.DATA_MANIPULATION,   policy: 'reconsider' },
  { id: 'content-sql-update-no-where', re: SQL_UPDATE_NO_WHERE_RE,   label: 'UPDATE without WHERE in payload', reason: REASON.DATA_MANIPULATION,   policy: 'reconsider' },
  { id: 'content-sql-drop-index-view', re: SQL_DROP_INDEX_VIEW_RE,   label: 'DROP INDEX/VIEW in payload',      reason: REASON.SCHEMA_MODIFICATION, policy: 'reconsider' },
  { id: 'content-sql-alter-drop-col',  re: SQL_ALTER_DROP_COLUMN_RE, label: 'ALTER DROP COLUMN in payload',    reason: REASON.SCHEMA_MODIFICATION, policy: 'reconsider' },

  // F3-2: same infra/data-store commands, caught when written into a script
  // or CI config (e.g. a generated `.sh` or pipeline yaml) rather than run
  // directly — reuses the exact same compiled RegExp objects as DANGEROUS_BASH.
  { id: 'content-terraform-destroy',            re: TF_DESTROY_RE,                  label: 'terraform/tofu destroy in payload',            reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-terraform-apply-unattended',   re: TF_APPLY_UNATTENDED_RE,         label: 'terraform/tofu apply -auto-approve/-destroy in payload', reason: REASON.INFRA_OPERATION, policy: 'reconsider' },
  { id: 'content-terraform-state-rm',           re: TF_STATE_RM_RE,                 label: 'terraform/tofu state rm in payload',           reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-terraform-workspace-delete',   re: TF_WORKSPACE_DELETE_RE,         label: 'terraform/tofu workspace delete in payload',   reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-terraform-force-unlock',       re: TF_FORCE_UNLOCK_RE,             label: 'terraform/tofu force-unlock in payload',       reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-helm-uninstall',               re: HELM_UNINSTALL_RE,              label: 'helm uninstall/delete in payload',             reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-kubectl-delete-critical',      re: KUBECTL_DELETE_CRITICAL_RE,     label: 'kubectl critical-resource delete in payload',  reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-kubectl-drain',                re: KUBECTL_DRAIN_RE,               label: 'kubectl drain in payload',                     reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-kubectl-replace-force',        re: KUBECTL_REPLACE_FORCE_RE,       label: 'kubectl replace --force in payload',           reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-pulumi-destroy',               re: PULUMI_DESTROY_RE,              label: 'pulumi destroy in payload',                    reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-pulumi-stack-rm',              re: PULUMI_STACK_RM_RE,             label: 'pulumi stack rm in payload',                   reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-gcloud-projects-delete',       re: GCLOUD_PROJECTS_DELETE_RE,      label: 'gcloud projects delete in payload',            reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-gcloud-sql-instances-delete',  re: GCLOUD_SQL_INSTANCES_DELETE_RE, label: 'gcloud sql instances delete in payload',       reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-gcloud-container-clusters-delete', re: GCLOUD_CONTAINER_CLUSTERS_DELETE_RE, label: 'gcloud container clusters delete in payload', reason: REASON.INFRA_OPERATION, policy: 'reconsider' },
  { id: 'content-gcloud-compute-instances-delete',  re: GCLOUD_COMPUTE_INSTANCES_DELETE_RE,  label: 'gcloud compute instances delete in payload',  reason: REASON.INFRA_OPERATION, policy: 'reconsider' },
  { id: 'content-gcloud-storage-rm-recursive',  re: GCLOUD_STORAGE_RM_RECURSIVE_RE, label: 'gcloud storage/gsutil rm -r in payload',       reason: REASON.FILE_DELETION,       policy: 'reconsider' },
  { id: 'content-aws-rds-delete',               re: AWS_RDS_DELETE_RE,              label: 'aws rds delete-db-instance/cluster in payload', reason: REASON.INFRA_OPERATION,    policy: 'reconsider' },
  { id: 'content-aws-ec2-terminate-instances',  re: AWS_EC2_TERMINATE_RE,           label: 'aws ec2 terminate-instances in payload',       reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-aws-cloudformation-delete-stack', re: AWS_CFN_DELETE_STACK_RE,     label: 'aws cloudformation delete-stack in payload',   reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-aws-eks-delete-cluster',       re: AWS_EKS_DELETE_CLUSTER_RE,      label: 'aws eks delete-cluster in payload',            reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-aws-dynamodb-delete-table',    re: AWS_DYNAMODB_DELETE_TABLE_RE,   label: 'aws dynamodb delete-table in payload',         reason: REASON.SCHEMA_MODIFICATION, policy: 'reconsider' },
  { id: 'content-aws-s3-rb-force',              re: AWS_S3_RB_FORCE_RE,             label: 'aws s3 rb --force in payload',                 reason: REASON.FILE_DELETION,       policy: 'reconsider' },
  { id: 'content-az-group-delete',              re: AZ_GROUP_DELETE_RE,             label: 'az group delete in payload',                   reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-az-aks-delete',                re: AZ_AKS_DELETE_RE,               label: 'az aks delete in payload',                     reason: REASON.INFRA_OPERATION,     policy: 'reconsider' },
  { id: 'content-az-sql-db-delete',             re: AZ_SQL_DB_DELETE_RE,            label: 'az sql db delete in payload',                  reason: REASON.SCHEMA_MODIFICATION, policy: 'reconsider' },
  { id: 'content-redis-flushall',               re: REDIS_FLUSH_RE,                 label: 'redis-cli FLUSHALL/FLUSHDB in payload',        reason: REASON.DATA_MANIPULATION,   policy: 'reconsider' },
  { id: 'content-mongo-drop-database',          re: MONGO_DROP_DATABASE_RE,         label: 'mongo dropDatabase() in payload',              reason: REASON.SCHEMA_MODIFICATION, policy: 'reconsider' },
  { id: 'content-docker-system-prune-all',      re: DOCKER_SYSTEM_PRUNE_ALL_RE,     label: 'docker system prune -a in payload',            reason: REASON.FILE_DELETION,       policy: 'reconsider' },
  { id: 'content-docker-volume-prune',          re: DOCKER_VOLUME_PRUNE_RE,         label: 'docker volume prune in payload',               reason: REASON.FILE_DELETION,       policy: 'reconsider' },
  { id: 'content-gh-repo-delete',               re: GH_REPO_DELETE_RE,              label: 'gh repo delete in payload',                    reason: REASON.FILE_DELETION,       policy: 'reconsider' },
] as const;
