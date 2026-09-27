/**
 * Unit tests for commands/doctor/compliance.ts (FR-DOC-0006).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildComplianceInstall,
  buildComplianceReport,
  listFilesBounded,
  isRosettaOwnedRelPath,
} from "../../../src/commands/doctor/compliance.js";
import type { DetectedInstall } from "../../../src/commands/doctor/detectors.js";

// Node's built-in "fs" is a frozen ESM namespace — vi.spyOn can't redefine its properties
// directly. Re-exporting a plain (spy-able) object via vi.mock is the standard workaround (see
// tests/unit/shared/doc-io.test.ts), used below to simulate one unreadable file without relying
// on OS file permissions (which the test runner may execute as root, bypassing them).
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual };
});

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-doctor-compliance-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function makeInstall(installDirAbs: string): DetectedInstall {
  return { ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") };
}

describe("buildComplianceInstall", () => {
  it("counts every Rosetta-owned file under the install dir", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "a.md"), "a");
    fs.writeFileSync(path.join(dir, "skills", "b.md"), "b");
    const entry = buildComplianceInstall(makeInstall(dir));
    expect(entry.file_count).toBe(2);
    expect(entry.truncated).toBe(false);
    expect(entry.combined_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same combined_hash across two runs when nothing changed", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "a.md"), "a");
    const first = buildComplianceInstall(makeInstall(dir));
    const second = buildComplianceInstall(makeInstall(dir));
    expect(first.combined_hash).toBe(second.combined_hash);
  });

  it("changes the combined_hash when a file's content changes", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "a.md"), "a");
    const before = buildComplianceInstall(makeInstall(dir));
    fs.writeFileSync(path.join(dir, "skills", "a.md"), "a-changed");
    const after = buildComplianceInstall(makeInstall(dir));
    expect(before.combined_hash).not.toBe(after.combined_hash);
  });

  it("excludes node_modules from the scan", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "skills", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "node_modules", "x.md"), "x");
    const entry = buildComplianceInstall(makeInstall(dir));
    expect(entry.file_count).toBe(0);
  });

  // FR-DOC-0006 review finding: hashing must be restricted to Rosetta-owned files, not every
  // file a user keeps alongside the install (e.g. their own .github/workflows/ci.yml).
  it("excludes files that are not under a Rosetta-owned subdirectory or top-level filename", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.mkdirSync(path.join(dir, "workflows"), { recursive: true }); // e.g. .github/workflows — not ours
    fs.writeFileSync(path.join(dir, "skills", "a.md"), "a");
    fs.writeFileSync(path.join(dir, "workflows", "ci.yml"), "name: ci");
    fs.writeFileSync(path.join(dir, "README.md"), "not ours either"); // unrecognized top-level file
    const entry = buildComplianceInstall(makeInstall(dir));
    expect(entry.file_count).toBe(1);
    expect(entry.skipped_large_files).toEqual([]);
    expect(entry.unreadable_files).toEqual([]);
  });

  it("includes the recognized top-level hooks.json file", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ hooks: {} }));
    const entry = buildComplianceInstall(makeInstall(dir));
    expect(entry.file_count).toBe(1);
  });

  // FR-DOC-0006 review finding: a single oversize owned file must be skipped and recorded, not
  // fail the whole compliance run.
  it("skips and records an owned file over the per-file size cap without failing the run", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "small.md"), "small");
    const bigPath = path.join(dir, "skills", "huge.md");
    fs.writeFileSync(bigPath, Buffer.alloc(2_000_001, "x"));
    const entry = buildComplianceInstall(makeInstall(dir));
    expect(entry.file_count).toBe(1);
    expect(entry.skipped_large_files).toEqual(["skills/huge.md"]);
    expect(entry.unreadable_files).toEqual([]);
  });

  // FR-DOC-0006 review finding: one unreadable owned file must be recorded, not throw and abort
  // the whole compliance scan (previously surfaced as doctor's internal_error). A real unreadable
  // file (permission-denied) is not reliably reproducible when tests run as root, so this
  // exercises the same code path by making readFileSync throw for exactly that one file.
  it("records an unreadable owned file instead of throwing", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "ok.md"), "ok");
    const brokenPath = path.join(dir, "skills", "broken.md");
    fs.writeFileSync(brokenPath, "will fail to read");

    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (p === brokenPath) throw new Error("EACCES: permission denied (simulated)");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalReadFileSync as any)(p, ...rest);
    });

    const entry = buildComplianceInstall(makeInstall(dir));
    expect(entry.file_count).toBe(1);
    expect(entry.unreadable_files).toEqual(["skills/broken.md"]);
  });

  it("records a file as unreadable when statSync itself fails (not just readFileSync)", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "ok.md"), "ok");
    const brokenPath = path.join(dir, "skills", "broken.md");
    fs.writeFileSync(brokenPath, "will fail to stat");

    const originalStatSync = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation((p: fs.PathLike, ...rest: unknown[]) => {
      if (p === brokenPath) throw new Error("ENOENT: simulated stat failure");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalStatSync as any)(p, ...rest);
    });

    const entry = buildComplianceInstall(makeInstall(dir));
    expect(entry.file_count).toBe(1);
    expect(entry.unreadable_files).toEqual(["skills/broken.md"]);
    expect(entry.skipped_large_files).toEqual([]);
  });
});

describe("isRosettaOwnedRelPath", () => {
  it("accepts files under a recognized subdirectory", () => {
    expect(isRosettaOwnedRelPath("skills/foo/SKILL.md")).toBe(true);
    expect(isRosettaOwnedRelPath("rules/INDEX.md")).toBe(true);
  });

  it("accepts the recognized top-level hooks.json", () => {
    expect(isRosettaOwnedRelPath("hooks.json")).toBe(true);
  });

  it("rejects an unrecognized top-level file or subdirectory", () => {
    expect(isRosettaOwnedRelPath("README.md")).toBe(false);
    expect(isRosettaOwnedRelPath("workflows/ci.yml")).toBe(false);
  });
});

describe("listFilesBounded", () => {
  it("recurses into a non-excluded nested subdirectory", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nested", "deep.md"), "x");
    const { files } = listFilesBounded(dir, 100);
    expect(files).toHaveLength(1);
  });

  it("sets truncated:true and stops once maxFiles is reached mid-directory", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    fs.writeFileSync(path.join(dir, "b.md"), "b");
    fs.writeFileSync(path.join(dir, "c.md"), "c");
    const { files, truncated } = listFilesBounded(dir, 2);
    expect(files).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("sets truncated:true when maxFiles is already reached before descending into a subdirectory", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    fs.writeFileSync(path.join(dir, "nested", "b.md"), "b");
    const { files, truncated } = listFilesBounded(dir, 1);
    expect(files).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it("sets truncated:true immediately when maxFiles is 0 (bound already exhausted before any entry)", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    const { files, truncated } = listFilesBounded(dir, 0);
    expect(files).toEqual([]);
    expect(truncated).toBe(true);
  });

  it("returns no files and no crash for an unreadable/nonexistent directory", () => {
    const { files, truncated } = listFilesBounded(path.join(root, "does-not-exist"), 100);
    expect(files).toEqual([]);
    expect(truncated).toBe(false);
  });
});

describe("buildComplianceReport", () => {
  it("builds one entry per install with a generated_at timestamp", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    const report = buildComplianceReport([makeInstall(dir)]);
    expect(report.installs).toHaveLength(1);
    expect(report.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns an empty installs array for no detected installs", () => {
    const report = buildComplianceReport([]);
    expect(report.installs).toEqual([]);
  });
});
