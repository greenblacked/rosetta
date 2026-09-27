/**
 * Unit tests for commands/doctor/compliance.ts (FR-DOC-0006).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildComplianceInstall, buildComplianceReport, listFilesBounded } from "../../../src/commands/doctor/compliance.js";
import type { DetectedInstall } from "../../../src/commands/doctor/detectors.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-doctor-compliance-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeInstall(installDirAbs: string): DetectedInstall {
  return { ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") };
}

describe("buildComplianceInstall", () => {
  it("counts every file under the install dir", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    fs.writeFileSync(path.join(dir, "b.md"), "b");
    const entry = buildComplianceInstall(makeInstall(dir));
    expect(entry.file_count).toBe(2);
    expect(entry.truncated).toBe(false);
    expect(entry.combined_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same combined_hash across two runs when nothing changed", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    const first = buildComplianceInstall(makeInstall(dir));
    const second = buildComplianceInstall(makeInstall(dir));
    expect(first.combined_hash).toBe(second.combined_hash);
  });

  it("changes the combined_hash when a file's content changes", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.md"), "a");
    const before = buildComplianceInstall(makeInstall(dir));
    fs.writeFileSync(path.join(dir, "a.md"), "a-changed");
    const after = buildComplianceInstall(makeInstall(dir));
    expect(before.combined_hash).not.toBe(after.combined_hash);
  });

  it("excludes node_modules from the scan", () => {
    const dir = path.join(root, "install");
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "x.md"), "x");
    const entry = buildComplianceInstall(makeInstall(dir));
    expect(entry.file_count).toBe(0);
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
