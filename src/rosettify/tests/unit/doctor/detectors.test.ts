/**
 * Unit tests for commands/doctor/detectors.ts (FR-DOC-0002..0005).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectInstalls, checkWorkspaceFiles, checkPlanHealth, checkHooks } from "../../../src/commands/doctor/detectors.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-doctor-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(relPath: string, data: unknown): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data));
}

function writeFile(relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("detectInstalls", () => {
  it("reports warn for every ide when nothing is installed", () => {
    const { checks, installs } = detectInstalls(root);
    expect(installs).toEqual([]);
    expect(checks.every((c) => c.status === "warn")).toBe(true);
    expect(checks.map((c) => c.id).sort()).toEqual(
      ["install.antigravity", "install.codex", "install.copilot", "install.cursor"].sort(),
    );
  });

  it("detects a cursor standalone install and reports its version", () => {
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    writeJson("plugin.json", { name: "core-cursor-standalone", version: "9.9.9" });
    const { checks, installs } = detectInstalls(root, ["cursor"]);
    expect(checks).toEqual([{ id: "install.cursor", status: "ok", detail: expect.stringContaining("9.9.9"), fix: "" }]);
    expect(installs).toHaveLength(1);
    expect(installs[0]!.ide).toBe("cursor");
  });

  it("does not falsely detect an unrelated plugin.json", () => {
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    writeJson("plugin.json", { name: "my-own-tool", version: "1.0.0" });
    const { checks, installs } = detectInstalls(root, ["cursor"]);
    expect(installs).toEqual([]);
    expect(checks[0]!.status).toBe("warn");
  });

  it("detects an antigravity install by its plugin.json name field", () => {
    writeJson(".agents/plugins/rosetta/plugin.json", { name: "rosetta", version: "3.1.13" });
    const { installs } = detectInstalls(root, ["antigravity"]);
    expect(installs).toHaveLength(1);
    expect(installs[0]!.version).toBe("3.1.13");
  });

  it("detects a codex install", () => {
    writeJson(".codex-plugin/plugin.json", { name: "rosetta", version: "1.2.3" });
    const { installs } = detectInstalls(root, ["codex"]);
    expect(installs).toHaveLength(1);
  });

  it("restricts detection to the supplied ide filter", () => {
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    writeJson("plugin.json", { name: "core-cursor-standalone", version: "1.0.0" });
    const { checks } = detectInstalls(root, ["codex"]);
    expect(checks.map((c) => c.id)).toEqual(["install.codex"]);
  });

  it("does not crash on an unreadable/invalid manifest", () => {
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    writeFile("plugin.json", "{{not json");
    const { installs } = detectInstalls(root, ["cursor"]);
    expect(installs).toEqual([]);
  });

  it("reports install.duplicate when a cursor standalone and a claude plugin manifest coexist", () => {
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    writeJson("plugin.json", { name: "core-cursor-standalone", version: "1.0.0" });
    writeJson(".claude-plugin/plugin.json", { name: "rosetta", version: "1.0.0" });
    const { checks } = detectInstalls(root, ["cursor"]);
    expect(checks.some((c) => c.id === "install.duplicate" && c.status === "warn")).toBe(true);
  });
});

describe("checkWorkspaceFiles", () => {
  it("reports ok for a present file and warn for an absent one", () => {
    writeFile("docs/CONTEXT.md", "# context");
    const checks = checkWorkspaceFiles(root);
    const context = checks.find((c) => c.id === "workspace.context-md")!;
    expect(context.status).toBe("ok");
    const gain = checks.find((c) => c.id === "workspace.gain-json")!;
    expect(gain.status).toBe("warn");
    expect(gain.fix).toContain("gain.json");
  });

  it("reports every check id exactly once, one per workspace file", () => {
    const checks = checkWorkspaceFiles(root);
    expect(checks).toHaveLength(10);
    expect(new Set(checks.map((c) => c.id)).size).toBe(10);
  });
});

describe("checkPlanHealth", () => {
  it("reports plan.none when there is no plans/ directory", () => {
    const checks = checkPlanHealth(root);
    expect(checks).toEqual([{ id: "plan.none", status: "ok", detail: expect.any(String), fix: "" }]);
  });

  it("reports ok for a valid plan.json", () => {
    writeJson("plans/checkout/plan.json", {
      name: "checkout",
      description: "",
      phases: [{ id: "ph-1", name: "phase one", steps: [] }],
    });
    const checks = checkPlanHealth(root);
    const entry = checks.find((c) => c.id === "plan.checkout")!;
    expect(entry.status).toBe("ok");
  });

  it("reports fail for invalid JSON", () => {
    writeFile("plans/checkout/plan.json", "{{not json");
    const checks = checkPlanHealth(root);
    const entry = checks.find((c) => c.id === "plan.checkout")!;
    expect(entry.status).toBe("fail");
  });

  it("reports fail for JSON that is not an object", () => {
    writeJson("plans/checkout/plan.json", [1, 2, 3]);
    const checks = checkPlanHealth(root);
    const entry = checks.find((c) => c.id === "plan.checkout")!;
    expect(entry.status).toBe("fail");
  });

  it("reports fail for a schema-invalid plan (duplicate ids)", () => {
    writeJson("plans/checkout/plan.json", {
      name: "checkout",
      phases: [
        { id: "ph-1", name: "p1", steps: [] },
        { id: "ph-1", name: "p2", steps: [] },
      ],
    });
    const checks = checkPlanHealth(root);
    const entry = checks.find((c) => c.id === "plan.checkout")!;
    expect(entry.status).toBe("fail");
  });

  it("reports fail when plan.json cannot be read as a file (e.g. it is itself a directory)", () => {
    fs.mkdirSync(path.join(root, "plans", "checkout", "plan.json"), { recursive: true });
    const checks = checkPlanHealth(root);
    const entry = checks.find((c) => c.id === "plan.checkout")!;
    expect(entry.status).toBe("fail");
    expect(entry.detail).toContain("could not be read");
  });

  it("reports plan.backups as warn when backup count exceeds retention", () => {
    for (let i = 0; i < 7; i++) {
      writeFile(`plans/checkout/plan.json.bak${String(i).padStart(3, "0")}`, "{}");
    }
    writeJson("plans/checkout/plan.json", { name: "checkout", phases: [] });
    const checks = checkPlanHealth(root);
    const backups = checks.find((c) => c.id === "plan.backups")!;
    expect(backups.status).toBe("warn");
  });

  it("reports plan.backups as ok when backup count is within retention", () => {
    writeJson("plans/checkout/plan.json", { name: "checkout", phases: [] });
    const checks = checkPlanHealth(root);
    const backups = checks.find((c) => c.id === "plan.backups")!;
    expect(backups.status).toBe("ok");
  });
});

describe("checkHooks", () => {
  it("reports warn when the install has no hooks.json", () => {
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs: path.join(root, ".cursor"), hooksPathAbs: path.join(root, ".cursor", "hooks.json") }]);
    expect(checks).toEqual([{ id: "hooks.cursor", status: "warn", detail: expect.any(String), fix: "" }]);
  });

  it("reports fail when hooks.json is not parseable JSON", () => {
    const installDirAbs = path.join(root, ".cursor");
    fs.mkdirSync(installDirAbs, { recursive: true });
    fs.writeFileSync(path.join(installDirAbs, "hooks.json"), "{{not json");
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }]);
    expect(checks[0]!.status).toBe("fail");
  });

  it("reports ok when hooks.json references no bundles", () => {
    const installDirAbs = path.join(root, ".cursor");
    fs.mkdirSync(installDirAbs, { recursive: true });
    fs.writeFileSync(path.join(installDirAbs, "hooks.json"), JSON.stringify({ version: 1, hooks: {} }));
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }]);
    expect(checks[0]!.status).toBe("ok");
  });

  it("reports ok when every referenced bundle resolves under the install dir", () => {
    const installDirAbs = path.join(root, ".cursor");
    fs.mkdirSync(path.join(installDirAbs, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(installDirAbs, "hooks", "guard.js"), "// noop");
    fs.writeFileSync(
      path.join(installDirAbs, "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node "hooks/guard.js"' }] }] } }),
    );
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }]);
    expect(checks[0]!.status).toBe("ok");
  });

  it("reports fail when a referenced bundle does not resolve", () => {
    const installDirAbs = path.join(root, ".cursor");
    fs.mkdirSync(installDirAbs, { recursive: true });
    fs.writeFileSync(
      path.join(installDirAbs, "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_DIR}/hooks/missing.js"' }] }] } }),
    );
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }]);
    expect(checks[0]!.status).toBe("fail");
  });
});
