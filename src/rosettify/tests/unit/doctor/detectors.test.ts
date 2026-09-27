/**
 * Unit tests for commands/doctor/detectors.ts (FR-DOC-0002..0005).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectInstalls, checkWorkspaceFiles, checkPlanHealth, checkHooks } from "../../../src/commands/doctor/detectors.js";

// Node's built-in "fs" is a frozen ESM namespace — vi.spyOn can't redefine its properties
// directly. Re-exporting a plain (spy-able) object via vi.mock is the standard workaround (see
// tests/unit/shared/doc-io.test.ts), used below to simulate an unreadable plans/ directory
// without relying on OS file permissions (the test runner may execute as root).
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual };
});

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-doctor-"));
});

afterEach(() => {
  vi.restoreAllMocks();
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

  // FR-DOC-0002 review finding: a Cursor standalone install alongside an unrelated `.github/`
  // directory (very common — CI workflows, issue templates) must not be reported as a Copilot
  // install just because a root plugin.json happens to exist and `.github/` is a directory.
  it("does not falsely detect copilot from an unrelated .github directory alongside a cursor install", () => {
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    writeFile(path.join(".github", "workflows", "ci.yml"), "name: ci");
    writeJson("plugin.json", { name: "core-cursor-standalone", version: "1.0.0" });
    const { checks, installs } = detectInstalls(root, ["cursor", "copilot"]);
    const copilot = checks.find((c) => c.id === "install.copilot")!;
    expect(copilot.status).toBe("warn");
    expect(installs.some((i) => i.ide === "copilot")).toBe(false);
  });

  it("detects a copilot standalone install when .github carries a skills subdirectory", () => {
    fs.mkdirSync(path.join(root, ".github", "skills"), { recursive: true });
    writeJson("plugin.json", { name: "core-copilot-standalone", version: "2.0.0" });
    const { checks, installs } = detectInstalls(root, ["copilot"]);
    expect(checks).toEqual([{ id: "install.copilot", status: "ok", detail: expect.stringContaining("2.0.0"), fix: "" }]);
    expect(installs).toHaveLength(1);
  });

  it("detects a copilot standalone install when .github carries a prompts subdirectory", () => {
    fs.mkdirSync(path.join(root, ".github", "prompts"), { recursive: true });
    writeJson("plugin.json", { name: "core-copilot-standalone", version: "2.0.0" });
    const { installs } = detectInstalls(root, ["copilot"]);
    expect(installs).toHaveLength(1);
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

  it("counts backups for a plan directory that has no plan.json of its own (still not a plan.<name> check)", () => {
    writeFile("plans/orphan-backups/plan.json.bak000", "{}");
    const checks = checkPlanHealth(root);
    expect(checks.find((c) => c.id === "plan.orphan-backups")).toBeUndefined();
    expect(checks.find((c) => c.id === "plan.backups")!.status).toBe("ok");
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

  // FR-DOC-0004 review finding: retention is per plan; two plans each within retention must not
  // warn just because their counts sum past the constant across plans/*/.
  it("reports plan.backups as ok when each plan is within retention even though the total across plans exceeds it", () => {
    for (let i = 0; i < 4; i++) writeFile(`plans/checkout/plan.json.bak${String(i).padStart(3, "0")}`, "{}");
    for (let i = 0; i < 4; i++) writeFile(`plans/billing/plan.json.bak${String(i).padStart(3, "0")}`, "{}");
    writeJson("plans/checkout/plan.json", { name: "checkout", phases: [] });
    writeJson("plans/billing/plan.json", { name: "billing", phases: [] });
    const checks = checkPlanHealth(root);
    const backups = checks.find((c) => c.id === "plan.backups")!;
    expect(backups.status).toBe("ok"); // 4 + 4 = 8 > retention(5), but no single plan exceeds it
  });

  it("does not crash when plans/ itself cannot be enumerated (readdirSync failure)", () => {
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    const plansAbs = path.join(root, "plans");
    const originalReaddirSync = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation((p: fs.PathLike, ...rest: unknown[]) => {
      if (p === plansAbs) throw new Error("EACCES: simulated");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalReaddirSync as any)(p, ...rest);
    });
    const checks = checkPlanHealth(root);
    expect(checks.find((c) => c.id === "plan.backups")!.status).toBe("ok");
  });

  it("does not crash when one plan directory's own entries cannot be listed (still checks the rest)", () => {
    writeJson("plans/checkout/plan.json", { name: "checkout", phases: [] });
    writeJson("plans/billing/plan.json", { name: "billing", phases: [] });
    const checkoutDirAbs = path.join(root, "plans", "checkout");
    const originalReaddirSync = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation((p: fs.PathLike, ...rest: unknown[]) => {
      if (p === checkoutDirAbs) throw new Error("EACCES: simulated");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalReaddirSync as any)(p, ...rest);
    });
    const checks = checkPlanHealth(root);
    expect(checks.find((c) => c.id === "plan.checkout")!.status).toBe("ok");
    expect(checks.find((c) => c.id === "plan.billing")!.status).toBe("ok");
    expect(checks.find((c) => c.id === "plan.backups")!.status).toBe("ok");
  });

  it("reports plan.backups as warn naming only the plan that exceeds retention", () => {
    for (let i = 0; i < 7; i++) writeFile(`plans/checkout/plan.json.bak${String(i).padStart(3, "0")}`, "{}");
    writeFile("plans/billing/plan.json.bak000", "{}");
    writeJson("plans/checkout/plan.json", { name: "checkout", phases: [] });
    writeJson("plans/billing/plan.json", { name: "billing", phases: [] });
    const checks = checkPlanHealth(root);
    const backups = checks.find((c) => c.id === "plan.backups")!;
    expect(backups.status).toBe("warn");
    expect(backups.detail).toContain("checkout");
    expect(backups.detail).not.toContain("billing (");
  });
});

describe("checkHooks", () => {
  it("reports warn when the install has no hooks.json", () => {
    const checks = checkHooks(
      [{ ide: "cursor", version: "1.0.0", installDirAbs: path.join(root, ".cursor"), hooksPathAbs: path.join(root, ".cursor", "hooks.json") }],
      root,
    );
    expect(checks).toEqual([{ id: "hooks.cursor", status: "warn", detail: expect.any(String), fix: "" }]);
  });

  it("reports fail when hooks.json is not parseable JSON", () => {
    const installDirAbs = path.join(root, ".cursor");
    fs.mkdirSync(installDirAbs, { recursive: true });
    fs.writeFileSync(path.join(installDirAbs, "hooks.json"), "{{not json");
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }], root);
    expect(checks[0]!.status).toBe("fail");
  });

  it("reports ok when hooks.json references no bundles", () => {
    const installDirAbs = path.join(root, ".cursor");
    fs.mkdirSync(installDirAbs, { recursive: true });
    fs.writeFileSync(path.join(installDirAbs, "hooks.json"), JSON.stringify({ version: 1, hooks: {} }));
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }], root);
    expect(checks[0]!.status).toBe("ok");
  });

  it("reports ok when every referenced bundle resolves under the install dir (macro-based, quoted)", () => {
    const installDirAbs = path.join(root, ".cursor");
    fs.mkdirSync(path.join(installDirAbs, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(installDirAbs, "hooks", "guard.js"), "// noop");
    fs.writeFileSync(
      path.join(installDirAbs, "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_DIR}/hooks/guard.js"' }] }] } }),
    );
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }], root);
    expect(checks[0]!.status).toBe("ok");
  });

  it("reports fail when a macro-resolved referenced bundle does not resolve", () => {
    const installDirAbs = path.join(root, ".cursor");
    fs.mkdirSync(installDirAbs, { recursive: true });
    fs.writeFileSync(
      path.join(installDirAbs, "hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_DIR}/hooks/missing.js"' }] }] } }),
    );
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }], root);
    expect(checks[0]!.status).toBe("fail");
  });

  // FR-DOC-0005 review finding: cursor/codex hooks.json commands are unquoted (real shape, e.g.
  // plugins/core-cursor-standalone/.cursor/skills/harness/references/hooks/cursor/hooks.json):
  // `node ${CLAUDE_PLUGIN_DIR}/skills/harness/scripts/tester.js --output '...'` — the bundle path
  // itself carries no surrounding quotes. Previously this was never matched, so a missing bundle
  // referenced this way was silently never reported.
  it("reports ok for an unquoted macro-based command whose bundle exists", () => {
    const installDirAbs = path.join(root, ".cursor");
    fs.mkdirSync(path.join(installDirAbs, "skills", "harness", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(installDirAbs, "skills", "harness", "scripts", "tester.js"), "// noop");
    fs.writeFileSync(
      path.join(installDirAbs, "hooks.json"),
      JSON.stringify({
        hooks: {
          sessionStart: [
            {
              type: "command",
              command:
                "node ${CLAUDE_PLUGIN_DIR}/skills/harness/scripts/tester.js --output '{\"additional_context\":\"x\"}' --tag sessionStart",
            },
          ],
        },
      }),
    );
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }], root);
    expect(checks[0]!.status).toBe("ok");
  });

  it("reports fail for an unquoted macro-based command whose bundle is missing", () => {
    const installDirAbs = path.join(root, ".cursor");
    fs.mkdirSync(installDirAbs, { recursive: true });
    fs.writeFileSync(
      path.join(installDirAbs, "hooks.json"),
      JSON.stringify({
        hooks: {
          sessionStart: [{ type: "command", command: "node ${CLAUDE_PLUGIN_DIR}/skills/harness/scripts/tester.js --tag sessionStart" }],
        },
      }),
    );
    const checks = checkHooks([{ ide: "cursor", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }], root);
    expect(checks[0]!.status).toBe("fail");
  });

  // FR-DOC-0005 review finding: a copilot command with no `${CLAUDE_PLUGIN_DIR}` macro is
  // relative to the workspace root, not to installDirAbs — joining it against installDirAbs
  // doubled the install dir's own name (`.github/.github/hooks/x.js`), a false "fail".
  it("resolves a macro-free relative bundle path against the workspace root, not the install dir", () => {
    const installDirAbs = path.join(root, ".github");
    fs.mkdirSync(path.join(installDirAbs, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(installDirAbs, "hooks", "x.js"), "// noop");
    fs.writeFileSync(
      path.join(installDirAbs, "hooks.json"),
      JSON.stringify({ hooks: { sessionStart: [{ bash: 'node ".github/hooks/x.js" --tag sessionStart' }] } }),
    );
    const checks = checkHooks([{ ide: "copilot", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }], root);
    expect(checks[0]!.status).toBe("ok");
  });

  it("reports fail (not a false ok) for a macro-free relative bundle path that truly does not exist", () => {
    const installDirAbs = path.join(root, ".github");
    fs.mkdirSync(installDirAbs, { recursive: true });
    fs.writeFileSync(
      path.join(installDirAbs, "hooks.json"),
      JSON.stringify({ hooks: { sessionStart: [{ bash: 'node ".github/hooks/missing.js" --tag sessionStart' }] } }),
    );
    const checks = checkHooks([{ ide: "copilot", version: "1.0.0", installDirAbs, hooksPathAbs: path.join(installDirAbs, "hooks.json") }], root);
    expect(checks[0]!.status).toBe("fail");
  });
});
