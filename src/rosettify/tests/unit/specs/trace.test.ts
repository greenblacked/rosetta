/**
 * Unit tests for commands/specs/trace.ts (FR-SPECS-0027).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdTrace } from "../../../src/commands/specs/trace.js";
import { saveSpecs } from "../../../src/commands/specs/core.js";
import { makeDoc, makeSpec } from "../../fixtures/specs.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-specs-trace-"));
});

afterEach(() => {
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
