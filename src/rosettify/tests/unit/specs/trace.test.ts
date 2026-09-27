/**
 * Unit tests for commands/specs/trace.ts (FR-SPECS-0027).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdTrace, collectFiles, walk } from "../../../src/commands/specs/trace.js";
import { saveSpecs } from "../../../src/commands/specs/core.js";
import { makeDoc, makeSpec } from "../../fixtures/specs.js";
import { logger } from "../../../src/shared/logger.js";

// Node's built-in "fs" and our own local ESM modules are frozen namespaces — vi.spyOn can't
// redefine their properties directly. Re-exporting a plain (spy-able) object via vi.mock is the
// standard workaround (see tests/unit/shared/doc-io.test.ts).
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual };
});
vi.mock("../../../src/shared/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/shared/logger.js")>();
  return { ...actual, logger: { ...actual.logger } };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-specs-trace-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function specsFile(name = "specs.json"): string {
  return path.join(tmpDir, name);
}

function writeSourceFile(relPath: string, content: string): string {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

describe("cmdTrace — document errors", () => {
  it("returns specs_not_found for a missing document", async () => {
    const result = await cmdTrace(specsFile("nope.json"), [tmpDir]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("specs_not_found");
  });

  it("returns specs_file_corrupted for invalid JSON", async () => {
    const file = specsFile();
    fs.writeFileSync(file, "{{not json{{");
    const result = await cmdTrace(file, [tmpDir]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("specs_file_corrupted");
  });

  it("returns invalid_regex for an uncompilable id_regex", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    const result = await cmdTrace(file, [tmpDir], { idRegexSrc: "(" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_regex");
  });
});

describe("cmdTrace — uncited / cited", () => {
  it("lists an Approved id with zero citations in uncited", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Approved" })] }));
    const result = await cmdTrace(file, [tmpDir]);
    expect(result.ok).toBe(true);
    expect(result.result!.uncited).toEqual(["FR-CHK-0001"]);
  });

  it("omits a Draft id from uncited even with zero citations", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Draft" })] }));
    const result = await cmdTrace(file, [tmpDir]);
    expect(result.ok).toBe(true);
    expect(result.result!.uncited).toEqual([]);
  });

  it("records a citation in a non-test file under code_refs with the correct line", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Approved" })] }));
    writeSourceFile("src/thing.ts", "line one\n// implements FR-CHK-0001\nline three\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    expect(result.ok).toBe(true);
    expect(result.result!.uncited).toEqual([]);
    const entry = result.result!.specs.find((s) => s.id === "FR-CHK-0001")!;
    expect(entry.code_refs).toEqual([{ file: expect.stringContaining("thing.ts"), line: 2 }]);
    expect(entry.test_refs).toEqual([]);
  });

  it("records a citation under a tests path in test_refs, not code_refs", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Approved" })] }));
    writeSourceFile("tests/thing.test.ts", "// FR-CHK-0001\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "tests")]);
    const entry = result.result!.specs.find((s) => s.id === "FR-CHK-0001")!;
    expect(entry.code_refs).toEqual([]);
    expect(entry.test_refs).toHaveLength(1);
  });

  it("reports both citations when an id appears twice in the same file", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Approved" })] }));
    writeSourceFile("src/thing.ts", "FR-CHK-0001\nFR-CHK-0001\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    const entry = result.result!.specs.find((s) => s.id === "FR-CHK-0001")!;
    expect(entry.code_refs).toHaveLength(2);
  });
});

describe("cmdTrace — orphans", () => {
  it("lists an id matched while scanning that the document does not define", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/thing.ts", "// see FR-GHOST-0001\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    expect(result.result!.orphans).toEqual([
      { id: "FR-GHOST-0001", refs: [{ file: expect.stringContaining("thing.ts"), line: 1 }] },
    ]);
  });

  it("does not list a defined id as an orphan", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Approved" })] }));
    writeSourceFile("src/thing.ts", "FR-CHK-0001\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    expect(result.result!.orphans).toEqual([]);
  });
});

describe("cmdTrace — exclusions and bounds", () => {
  it("excludes files under a node_modules directory", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/node_modules/pkg/index.ts", "// FR-GHOST-0002\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    expect(result.result!.orphans).toEqual([]);
  });

  it("only scans files with a recognized (or supplied) extension", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/data.bin", "FR-GHOST-0003\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    expect(result.result!.orphans).toEqual([]);
  });

  it("scans a supplied extra extension when explicitly passed", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/data.bin", "FR-GHOST-0004\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")], { extensions: [".bin"] });
    expect(result.result!.orphans.map((o) => o.id)).toEqual(["FR-GHOST-0004"]);
  });

  it("reports scanned_files matching the number of files actually read", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/a.ts", "");
    writeSourceFile("src/b.ts", "");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    expect(result.result!.scanned_files).toBe(2);
  });

  it("falls back to cwd's src/tests default when no source_paths are given and none exist", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    const result = await cmdTrace(file, undefined);
    expect(result.ok).toBe(true);
  });

  it("reports truncated:false for a normal, unbounded-by-nothing scan", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/a.ts", "");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    expect(result.result!.truncated).toBe(false);
  });

  it("classifies a file matching a caller-supplied tests_glob as a test file", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Approved" })] }));
    writeSourceFile("weird/spot/checker.ts", "FR-CHK-0001\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "weird")], { testsGlob: "*checker*" });
    const entry = result.result!.specs.find((s) => s.id === "FR-CHK-0001")!;
    expect(entry.test_refs).toHaveLength(1);
    expect(entry.code_refs).toHaveLength(0);
  });

  it("skips a file that becomes unreadable between listing and reading, without failing the scan", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    const goodAbs = writeSourceFile("src/good.ts", "FR-GHOST-0001\n");
    const brokenAbs = writeSourceFile("src/broken.ts", "FR-GHOST-0002\n");

    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (p === brokenAbs) throw new Error("EACCES: simulated");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalReadFileSync as any)(p, ...rest);
    });

    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    expect(result.ok).toBe(true);
    const ids = result.result!.orphans.map((o) => o.id);
    expect(ids).toContain("FR-GHOST-0001");
    expect(ids).not.toContain("FR-GHOST-0002");
    void goodAbs;
  });

  it("returns internal_error (not a thrown exception) when an unexpected failure occurs mid-scan", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/a.ts", "");
    vi.spyOn(logger, "info").mockImplementation(() => {
      throw new Error("simulated logging failure");
    });
    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("internal_error");
    expect(result.error).toContain("simulated logging failure");
  });

  it("returns internal_error with String(e) when the unexpected failure is not an Error instance", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/a.ts", "");
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    vi.spyOn(logger, "info").mockImplementation(() => {
      throw "plain string failure";
    });
    const result = await cmdTrace(file, [path.join(tmpDir, "src")]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("internal_error: plain string failure");
  });

  it("accepts an extension supplied without its leading dot", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Approved" })] }));
    writeSourceFile("src/thing.ts", "FR-CHK-0001\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")], { extensions: ["ts"] });
    expect(result.result!.uncited).toEqual([]);
  });

  it("treats a document with no specs array at all as defining zero ids", async () => {
    const file = specsFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ system: "x", description: "", created_at: "", updated_at: "", previous_version: null, purged_ids: [], areas: [] }),
    );
    const result = await cmdTrace(file, [tmpDir]);
    expect(result.ok).toBe(true);
    expect(result.result!.specs).toEqual([]);
  });

  it("guards against an infinite loop on a zero-width id_regex match", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/z.ts", "FR-CHK-0001\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")], { idRegexSrc: "(?=FR-CHK-0001)" });
    expect(result.ok).toBe(true);
  });
});

// FR-SPECS-0027 review finding: skipped_files previously counted only oversize skips; files cut
// off by the file-count bound were silently dropped (never counted, never flagged). These
// exercise collectFiles directly with tiny bounds instead of creating tens of thousands of
// fixture files.
describe("collectFiles — truncation", () => {
  it("counts a file cut off by the file-count bound in skipped_files and sets truncated:true", () => {
    writeSourceFile("trunc/a.ts", "");
    writeSourceFile("trunc/b.ts", "");
    writeSourceFile("trunc/c.ts", "");
    const state = collectFiles([path.join(tmpDir, "trunc")], new Set([".ts"]), 2, 100);
    expect(state.files).toHaveLength(2);
    expect(state.skipped).toBeGreaterThanOrEqual(1);
    expect(state.truncated).toBe(true);
  });

  it("does not set truncated when every file fits within the bound", () => {
    writeSourceFile("ok/a.ts", "");
    writeSourceFile("ok/b.ts", "");
    const state = collectFiles([path.join(tmpDir, "ok")], new Set([".ts"]), 100, 100);
    expect(state.files).toHaveLength(2);
    expect(state.skipped).toBe(0);
    expect(state.truncated).toBe(false);
  });

  it("skips and counts an oversize file without adding it to files", () => {
    fs.mkdirSync(path.join(tmpDir, "big"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "big", "small.ts"), "ok");
    fs.writeFileSync(path.join(tmpDir, "big", "huge.ts"), Buffer.alloc(2_000_001, "x"));
    const state = collectFiles([path.join(tmpDir, "big")], new Set([".ts"]), 100, 100);
    expect(state.files).toHaveLength(1);
    expect(state.skipped).toBe(1);
    expect(state.truncated).toBe(false); // an oversize skip alone does not mean the walk was incomplete
  });

  it("skips a directory entry (not a file) that is not a real file, e.g. a broken symlink", () => {
    const dir = path.join(tmpDir, "symdir");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(dir, "does-not-exist"), path.join(dir, "link.ts"));
    const state = collectFiles([dir], new Set([".ts"]), 100, 100);
    expect(state.files).toEqual([]);
  });

  it("walk: sets truncated:true when a directory entry is reached after the file bound is already exhausted", () => {
    fs.mkdirSync(path.join(tmpDir, "boundary", "sub"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "boundary", "sub", "deep.ts"), "");
    // Pre-seed state as if the file bound (1) is already met before walk() even looks at
    // "boundary/", so its only entry ("sub/", a directory) is skipped deterministically —
    // independent of readdir's entry ordering.
    const state = { files: ["already-at-bound.ts"], skipped: 0, truncated: false, dirsVisited: 0 };
    walk(path.join(tmpDir, "boundary"), new Set([".ts"]), state, 1, 100);
    expect(state.truncated).toBe(true);
    expect(state.files).toEqual(["already-at-bound.ts"]); // sub/ was never descended into
  });

  it("stops before statting a later root once an earlier root already exhausted the file bound", () => {
    fs.mkdirSync(path.join(tmpDir, "multi"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "multi", "a.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "multi", "b.ts"), "");
    const unreachableRoot = path.join(tmpDir, "does-not-exist-and-should-never-be-statted");
    const state = collectFiles([path.join(tmpDir, "multi"), unreachableRoot], new Set([".ts"]), 1, 100);
    expect(state.files).toHaveLength(1);
    expect(state.truncated).toBe(true);
  });

  it("accepts a root that is itself a single matching file, not a directory", () => {
    const filePath = writeSourceFile("standalone/only.ts", "");
    const state = collectFiles([filePath], new Set([".ts"]), 100, 100);
    expect(state.files).toEqual([filePath]);
  });

  it("ignores a root that is itself a single file with a non-matching extension", () => {
    const filePath = writeSourceFile("standalone/only.txt", "");
    const state = collectFiles([filePath], new Set([".ts"]), 100, 100);
    expect(state.files).toEqual([]);
  });

  it("sets truncated:true when the directory-count bound is hit before a nested file is visited", () => {
    writeSourceFile("dirs/a/deep.ts", "");
    writeSourceFile("dirs/b/deep.ts", "");
    writeSourceFile("dirs/c/deep.ts", "");
    // maxDirs:1 — the root "dirs" directory itself consumes the one allowed directory visit, so
    // none of a/, b/, c/ are ever descended into.
    const state = collectFiles([path.join(tmpDir, "dirs")], new Set([".ts"]), 100, 1);
    expect(state.files).toHaveLength(0);
    expect(state.truncated).toBe(true);
  });

  it("cmdTrace: reports truncated:true and skipped_files when maxFiles is overridden below the file count", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/a.ts", "");
    writeSourceFile("src/b.ts", "");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")], { maxFiles: 1 });
    expect(result.result!.scanned_files).toBe(1);
    expect(result.result!.skipped_files).toBeGreaterThanOrEqual(1);
    expect(result.result!.truncated).toBe(true);
  });

  it("cmdTrace: --strict treats a truncated scan as violated even with no uncited/orphan findings", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] })); // no specs defined at all -> uncited/orphans both empty
    writeSourceFile("src/a.ts", "");
    writeSourceFile("src/b.ts", "");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")], { strict: true, maxFiles: 1 });
    expect(result.result!.uncited).toEqual([]);
    expect(result.result!.orphans).toEqual([]);
    expect(result.result!.truncated).toBe(true);
    expect(result.result!.violated).toBe(true);
  });
});

describe("cmdTrace — id_prefixes override", () => {
  it("matches only ids carrying the supplied prefix", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [] }));
    writeSourceFile("src/thing.ts", "FR-CHK-0001 and NFR-PERF-0001\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")], { idPrefixes: ["FR"] });
    expect(result.result!.orphans.map((o) => o.id)).toEqual(["FR-CHK-0001"]);
  });
});

describe("cmdTrace — strict mode", () => {
  it("sets violated:true when strict and findings exist", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Approved" })] }));
    const result = await cmdTrace(file, [tmpDir], { strict: true });
    expect(result.result!.violated).toBe(true);
  });

  it("leaves violated:false when strict but no findings exist", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Approved" })] }));
    writeSourceFile("src/thing.ts", "FR-CHK-0001\n");
    const result = await cmdTrace(file, [path.join(tmpDir, "src")], { strict: true });
    expect(result.result!.violated).toBe(false);
  });

  it("leaves violated:false when not strict, even with findings", async () => {
    const file = specsFile();
    saveSpecs(file, makeDoc({ specs: [makeSpec({ id: "FR-CHK-0001", status: "Approved" })] }));
    const result = await cmdTrace(file, [tmpDir]);
    expect(result.result!.violated).toBe(false);
  });
});
