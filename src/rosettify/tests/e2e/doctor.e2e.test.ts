/**
 * doctor command E2E tests — spawns the built rosettify binary as a subprocess (FR-DOC-*).
 *
 * Requires: npm run build must have been run first.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../");
const BIN = path.join(REPO_ROOT, "dist/bin/rosettify.js");
const NODE = process.execPath;

let tmpDir: string;

beforeAll(() => {
  if (!fs.existsSync(BIN)) {
    throw new Error(`Binary not found: ${BIN}. Run 'npm run build --prefix rosettify' first.`);
  }
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-e2e-doctor-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
  json: unknown;
}

function run(args: string[]): SpawnResult {
  const result = spawnSync(NODE, [BIN, ...args], { encoding: "utf8", timeout: 15000 });
  let json: unknown = null;
  const out = result.stdout ?? "";
  try {
    json = JSON.parse(out);
  } catch {
    // not JSON — acceptable for some cases
  }
  return { stdout: out, stderr: result.stderr ?? "", status: result.status, json };
}

describe("CLI — doctor", () => {
  it("exits 0 and returns a DoctorResult shape against an empty root", () => {
    const result = run(["doctor", "--root", tmpDir]);
    expect(result.status).toBe(0);
    const payload = result.json as {
      root: string;
      checks: { id: string; status: string; detail: string; fix: string }[];
      summary: { ok_count: number; warn_count: number; fail_count: number };
    };
    expect(payload.root).toBe(tmpDir);
    expect(payload.checks.length).toBeGreaterThan(0);
    expect(payload.summary.fail_count).toBe(0);
    expect(payload.compliance).toBeUndefined();
  });

  it("exits 1 and reports root_not_found for a nonexistent root", () => {
    const result = run(["doctor", "--root", path.join(tmpDir, "nope")]);
    expect(result.status).toBe(1);
    expect(result.json).toEqual({ error: "root_not_found" });
  });

  it("detects a workspace file that is present", () => {
    fs.mkdirSync(path.join(tmpDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "docs", "CONTEXT.md"), "# context");
    const result = run(["doctor", "--root", tmpDir]);
    const payload = result.json as { checks: { id: string; status: string }[] };
    const contextCheck = payload.checks.find((c) => c.id === "workspace.context-md")!;
    expect(contextCheck.status).toBe("ok");
  });

  it("detects a standalone cursor install and reports its version", () => {
    fs.mkdirSync(path.join(tmpDir, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "plugin.json"), JSON.stringify({ name: "core-cursor-standalone", version: "9.9.9" }));
    const result = run(["doctor", "--root", tmpDir, "--ide", "cursor"]);
    const payload = result.json as { checks: { id: string; status: string; detail: string }[] };
    const cursorCheck = payload.checks.find((c) => c.id === "install.cursor")!;
    expect(cursorCheck.status).toBe("ok");
    expect(cursorCheck.detail).toContain("9.9.9");
  });

  it("adds a compliance report with --compliance for a detected install", () => {
    fs.mkdirSync(path.join(tmpDir, ".cursor", "skills"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".cursor", "skills", "agents.md"), "x");
    fs.writeFileSync(path.join(tmpDir, "plugin.json"), JSON.stringify({ name: "core-cursor-standalone", version: "1.0.0" }));
    const result = run(["doctor", "--root", tmpDir, "--ide", "cursor", "--compliance"]);
    const payload = result.json as {
      compliance?: { installs: { ide: string; combined_hash: string; file_count: number }[] };
    };
    expect(payload.compliance).toBeDefined();
    expect(payload.compliance!.installs).toHaveLength(1);
    expect(payload.compliance!.installs[0]!.ide).toBe("cursor");
    expect(payload.compliance!.installs[0]!.file_count).toBe(1);
  });

  it("--json is accepted and does not change the output shape", () => {
    const withFlag = run(["doctor", "--root", tmpDir, "--json"]);
    const withoutFlag = run(["doctor", "--root", tmpDir]);
    expect(Object.keys(withFlag.json as object).sort()).toEqual(Object.keys(withoutFlag.json as object).sort());
    expect(withFlag.status).toBe(0);
  });

  it("rosettify help doctor returns doctor detail", () => {
    const result = run(["help", "doctor"]);
    expect(result.status).toBe(0);
    const payload = result.json as { name: string; schemas: unknown };
    expect(payload.name).toBe("doctor");
    expect(payload.schemas).toBeDefined();
  });
});
