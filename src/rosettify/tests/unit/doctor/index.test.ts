/**
 * Unit tests for commands/doctor/index.ts — the doctorToolDef.run delegate (FR-DOC-0001).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { doctorToolDef } from "../../../src/commands/doctor/index.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-doctor-index-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("doctorToolDef.run", () => {
  it("forwards root/ide/compliance to cmdDoctor and returns ok:true", async () => {
    const result = await doctorToolDef.run({ root, ide: ["cursor"], compliance: false });
    expect(result.ok).toBe(true);
    expect(result.result!.root).toBe(root);
  });

  it("forwards compliance:true through", async () => {
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "core-cursor-standalone", version: "1.0.0" }));
    const result = await doctorToolDef.run({ root, ide: ["cursor"], compliance: true });
    expect(result.ok).toBe(true);
    expect(result.result!.compliance).toBeDefined();
  });

  it("carries the doctor name/brief/description/schemas on the ToolDef itself", () => {
    expect(doctorToolDef.name).toBe("doctor");
    expect(doctorToolDef.cli).toBe(true);
    expect(doctorToolDef.mcp).toBe(true);
    expect(doctorToolDef.helpContent).toBeDefined();
  });
});
