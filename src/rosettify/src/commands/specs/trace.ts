// Implements FR-SPECS-0027 (specs trace: requirement id <-> code/test citation traceability).
// Read-only: never writes a file, never calls the network. Walks caller-supplied (or default)
// source directories, matches requirement-shaped ids by regex, and cross-references them against
// the specs document's own defined ids.

import * as fs from "fs";
import * as path from "path";
import type { RunEnvelope } from "../../registry/types.js";
import { ok, err } from "../../shared/envelope.js";
import { logger } from "../../shared/logger.js";
import { readDocWithRetry } from "../../shared/doc-io.js";
import {
  TRACE_MAX_FILES,
  TRACE_MAX_FILE_SIZE_BYTES,
  TRACE_MAX_DIRS,
  TRACE_EXCLUDED_DIRS,
  TRACE_DEFAULT_EXTENSIONS,
} from "../../shared/constants.js";
import type { SpecsDocument, StatusEnum } from "./core.js";
import { ERR_SPECS_FILE_CORRUPTED, ERR_SPECS_NOT_FOUND, ERR_INVALID_REGEX } from "./errors.js";
import type { SpecTraceEntry, SpecTraceOrphan, SpecTraceRef, SpecTraceResult } from "./output.js";

export interface TraceOptions {
  idRegexSrc?: string;
  idPrefixes?: string[];
  testsGlob?: string;
  extensions?: string[];
  strict?: boolean;
  // Not exposed via the CLI/MCP schema — override the TRACE_MAX_FILES/TRACE_MAX_DIRS bounds
  // (default when omitted) so truncation behavior can be exercised directly without creating
  // tens of thousands of fixture files/dirs.
  maxFiles?: number;
  maxDirs?: number;
}

// FR-SPECS-0004 — the id grammar `<PREFIX>-<AREA>-<NNNN>`, PREFIX in FR|NFR|INT|DATA by default.
const DEFAULT_ID_REGEX_SRC = "\\b(?:FR|NFR|INT|DATA)-[A-Z][A-Z0-9]{1,20}-\\d{4}\\b";

function buildIdRegex(idRegexSrc?: string, idPrefixes?: string[]): RegExp {
  if (idRegexSrc) {
    // A caller-supplied pattern without the global flag would only ever report the first match
    // per line — always scan globally regardless of what the caller wrote.
    return new RegExp(idRegexSrc, "g");
  }
  if (idPrefixes && idPrefixes.length > 0) {
    const alt = idPrefixes
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean)
      .join("|");
    if (alt) return new RegExp(`\\b(?:${alt})-[A-Z][A-Z0-9]{1,20}-\\d{4}\\b`, "g");
  }
  return new RegExp(DEFAULT_ID_REGEX_SRC, "g");
}

/** Very small glob-ish matcher: `*` -> any run of characters, everything else literal. Falls
 * back to a plain substring test when the pattern has no `*` at all. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(escaped, "i");
}

function isTestFile(relPath: string, testsGlob?: string): boolean {
  if (testsGlob) return globToRegExp(testsGlob).test(relPath);
  const base = path.basename(relPath).toLowerCase();
  if (/\.test\.|\.spec\.|_test\./.test(base)) return true;
  return /(^|[/\\])tests?([/\\]|$)/i.test(relPath);
}

function defaultSourceRoots(): string[] {
  const cwd = process.cwd();
  const candidates = ["src", "tests", "test"].map((c) => path.join(cwd, c)).filter((p) => fs.existsSync(p));
  return candidates.length > 0 ? candidates : [cwd];
}

// FR-SPECS-0027 review finding — `skipped_files` counts both an oversize file (examined, but its
// content not read) and a file the file-count bound cut off (never examined at all); `truncated`
// separately flags that LATTER case — the scan stopped before visiting the whole tree, so
// `uncited`/`orphans` are not a definitive account of every citation, whereas an oversize skip
// alone does not compromise completeness of the directory walk itself. `dirsVisited` bounds the
// walk independent of file count, so a tree with many directories but few matching files cannot
// make the scan unbounded in wall time.
export interface WalkState {
  files: string[];
  skipped: number;
  truncated: boolean;
  dirsVisited: number;
}

// Exported alongside collectFiles purely so directory-level truncation edge cases (a directory
// entry skipped because the file bound was already exhausted by the time it is reached) can be
// exercised deterministically in tests, without depending on filesystem readdir ordering.
export function walk(dir: string, extensions: ReadonlySet<string>, state: WalkState, maxFiles: number, maxDirs: number): void {
  if (state.dirsVisited >= maxDirs) {
    state.truncated = true;
    return;
  }
  state.dirsVisited++;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip silently, mirrors best-effort scanning elsewhere
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (TRACE_EXCLUDED_DIRS.has(entry.name)) continue;
      if (state.files.length >= maxFiles) {
        // The file bound is already exhausted; stop descending further (cheap: no more readdir
        // calls), but the walk is not complete, so this is a truncation, not just a skip.
        state.truncated = true;
        continue;
      }
      walk(path.join(dir, entry.name), extensions, state, maxFiles, maxDirs);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!extensions.has(ext)) continue;
    if (state.files.length >= maxFiles) {
      // Cut off by the file-count bound (never examined) — counted in skipped_files per
      // FR-SPECS-0027, and distinctly flagged via `truncated` since, unlike an oversize skip,
      // it means the scan did not finish visiting every matching file.
      state.skipped++;
      state.truncated = true;
      continue;
    }
    const full = path.join(dir, entry.name);
    let size: number;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (size > TRACE_MAX_FILE_SIZE_BYTES) {
      state.skipped++;
      continue;
    }
    state.files.push(full);
  }
}

/** Exported (with overridable bounds) so the file-count/directory-count truncation behavior can
 * be exercised directly in tests without creating tens of thousands of fixture files/dirs. */
export function collectFiles(
  roots: string[],
  extensions: ReadonlySet<string>,
  maxFiles: number = TRACE_MAX_FILES,
  maxDirs: number = TRACE_MAX_DIRS,
): WalkState {
  const state: WalkState = { files: [], skipped: 0, truncated: false, dirsVisited: 0 };
  for (const root of roots) {
    if (state.files.length >= maxFiles) {
      state.truncated = true;
      break;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(root, extensions, state, maxFiles, maxDirs);
    } else if (stat.isFile()) {
      const ext = path.extname(root).toLowerCase();
      if (extensions.has(ext)) state.files.push(root);
    }
  }
  return state;
}

export async function cmdTrace(
  specsFile: string,
  sourcePaths: string[] | undefined,
  options: TraceOptions = {},
): Promise<RunEnvelope<SpecTraceResult>> {
  try {
    let doc: SpecsDocument | null;
    try {
      doc = await readDocWithRetry<SpecsDocument>(specsFile);
    } catch {
      return err(ERR_SPECS_FILE_CORRUPTED);
    }
    if (!doc) return err(ERR_SPECS_NOT_FOUND);

    let idRegex: RegExp;
    try {
      idRegex = buildIdRegex(options.idRegexSrc, options.idPrefixes);
    } catch {
      return err(ERR_INVALID_REGEX);
    }

    const extensions = new Set(
      (options.extensions && options.extensions.length > 0 ? options.extensions : TRACE_DEFAULT_EXTENSIONS).map((e) =>
        e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`,
      ),
    );

    const roots = sourcePaths && sourcePaths.length > 0 ? sourcePaths : defaultSourceRoots();
    const { files, skipped, truncated } = collectFiles(
      roots,
      extensions,
      options.maxFiles ?? TRACE_MAX_FILES,
      options.maxDirs ?? TRACE_MAX_DIRS,
    );

    const definedIds = new Map<string, StatusEnum>();
    for (const spec of doc.specs ?? []) definedIds.set(spec.id, spec.status);

    const citations = new Map<string, { code: SpecTraceRef[]; test: SpecTraceRef[] }>();
    const orphanCitations = new Map<string, SpecTraceRef[]>();

    const cwd = process.cwd();
    for (const file of files) {
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(cwd, file) || file;
      const isTest = isTestFile(rel, options.testsGlob);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i]!;
        idRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = idRegex.exec(lineText)) !== null) {
          const id = match[0];
          const ref: SpecTraceRef = { file: rel, line: i + 1 };
          if (definedIds.has(id)) {
            let bucket = citations.get(id);
            if (!bucket) {
              bucket = { code: [], test: [] };
              citations.set(id, bucket);
            }
            (isTest ? bucket.test : bucket.code).push(ref);
          } else {
            let list = orphanCitations.get(id);
            if (!list) {
              list = [];
              orphanCitations.set(id, list);
            }
            list.push(ref);
          }
          if (match.index === idRegex.lastIndex) idRegex.lastIndex++; // guard against zero-width matches
        }
      }
    }

    const specsOut: SpecTraceEntry[] = [];
    const uncited: string[] = [];
    for (const [id, status] of definedIds) {
      const bucket = citations.get(id) ?? { code: [], test: [] };
      specsOut.push({ id, status, code_refs: bucket.code, test_refs: bucket.test });
      if ((status === "Approved" || status === "Modified") && bucket.code.length === 0 && bucket.test.length === 0) {
        uncited.push(id);
      }
    }
    specsOut.sort((a, b) => a.id.localeCompare(b.id));
    uncited.sort();

    const orphans: SpecTraceOrphan[] = [...orphanCitations.entries()]
      .map(([id, refs]) => ({ id, refs }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const strict = !!options.strict;
    // FR-SPECS-0027 review finding — a truncated scan means uncited/orphans are not a definitive
    // account of every citation (some matching files were never visited), so --strict treats
    // truncation itself as a violation rather than silently reporting a possibly-incomplete
    // "clean" result as passing.
    const violated = strict && (uncited.length > 0 || orphans.length > 0 || truncated);

    const result: SpecTraceResult = {
      specs: specsOut,
      uncited,
      orphans,
      scanned_files: files.length,
      skipped_files: skipped,
      truncated,
      violated,
    };
    logger.info(
      { specsFile, scanned: result.scanned_files, uncited: uncited.length, orphans: orphans.length, truncated },
      "specs trace",
    );
    return ok(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`internal_error: ${msg}`);
  }
}
