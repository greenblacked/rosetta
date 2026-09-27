/**
 * Unit tests for commands/doctor/core.ts (FR-DOC-0001, FR-DOC-0006).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdDoctor } from "../../../src/commands/doctor/core.js";
import * as compliance from "../../../src/commands/doctor/compliance.js";

// Node's built-in "fs" and our own local ESM modules are frozen namespaces — vi.spyOn can't
// redefine their properties directly. Re-exporting a plain (spy-able) object via vi.mock is the
// standard workaround (see tests/unit/shared/doc-io.test.ts), used below to force an unexpected
// failure deep in the scan so cmdDoctor's own internal_error catch path is exercised.
vi.mock("../../../src/commands/doctor/compliance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/commands/doctor/compliance.js")>();
  return { ...actual };
});

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-doctor-core-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cmdDoctor", () => {
  it("returns root_not_found for a nonexistent root", async () => {
    const result = await cmdDoctor({ root: path.join(root, "nope") });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("root_not_found");
  });

  it("returns root_not_found when root is a file, not a directory", async () => {
    const filePath = path.join(root, "not-a-dir");
    fs.writeFileSync(filePath, "x");
    const result = await cmdDoctor({ root: filePath });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("root_not_found");
  });

  it("defaults root to cwd when not supplied", async () => {
    const result = await cmdDoctor({});
    expect(result.ok).toBe(true);
    expect(result.result!.root).toBe(process.cwd());
  });

  it("returns ok:true with a summary matching the checks even when every check warns", async () => {
    const result = await cmdDoctor({ root });
    expect(result.ok).toBe(true);
    const { checks, summary } = result.result!;
    expect(summary.ok_count + summary.warn_count + summary.fail_count).toBe(checks.length);
    expect(summary.fail_count).toBe(0);
  });

  it("omits compliance from the result when compliance is not requested", async () => {
    const result = await cmdDoctor({ root });
    expect(result.result!.compliance).toBeUndefined();
  });

  it("adds a compliance report with one entry per detected install", async () => {
    fs.mkdirSync(path.join(root, ".cursor", "skills"), { recursive: true });
    fs.writeFileSync(path.join(root, ".cursor", "skills", "agents.md"), "x");
    fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "core-cursor-standalone", version: "1.0.0" }));
    const result = await cmdDoctor({ root, compliance: true, ide: ["cursor"] });
    expect(result.result!.compliance).toBeDefined();
    expect(result.result!.compliance!.installs).toHaveLength(1);
    expect(result.result!.compliance!.installs[0]!.file_count).toBeGreaterThan(0);
  });

  it("restricts install detection to the supplied ide list", async () => {
    const result = await cmdDoctor({ root, ide: ["codex"] });
    expect(result.result!.checks.filter((c) => c.id.startsWith("install."))).toHaveLength(1);
  });

  it("returns internal_error (not a thrown exception) when a downstream step fails unexpectedly", async () => {
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "core-cursor-standalone", version: "1.0.0" }));
    vi.spyOn(compliance, "buildComplianceReport").mockImplementation(() => {
      throw new Error("simulated downstream failure");
    });
    const result = await cmdDoctor({ root, compliance: true, ide: ["cursor"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("internal_error");
    expect(result.error).toContain("simulated downstream failure");
  });
});
