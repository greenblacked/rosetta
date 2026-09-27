/**
 * Unit tests for cmdCreate (FR-PLAN-0010 / FR-PLAN-0040).
 * Updated for Phase 9: expects compressed-tree result shape, previous_version field,
 * and pretty-formatted file on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cmdCreate } from "../../../src/commands/plan/create.js";
import { loadPlan } from "../../../src/commands/plan/core.js";
import type { PlanWriteResult } from "../../../src/commands/plan/output.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-create-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function planFile(name = "plan.json"): string {
  return path.join(tmpDir, name);
}

describe("cmdCreate — FR-PLAN-0010 / FR-PLAN-0040", () => {
  // FR-PLAN-0040 — create returns compressed-tree shape
  it("returns compressed-tree result on first create", async () => {
    const file = planFile();
    const result = await cmdCreate(file, { name: "My Plan" });

    expect(result.ok).toBe(true);
    const tree = result.result as PlanWriteResult;

    // FR-PLAN-0040 — root fields
    expect(tree.plan).toBeDefined();
    expect(tree.plan.name).toBe("My Plan");
    expect(tree.plan.status).toBe("open");
    expect(Array.isArray(tree.phases)).toBe(true);

    // No old-shape fields (plan_file, name at root, status at root)
    expect((tree as Record<string, unknown>)["plan_file"]).toBeUndefined();
    expect((tree as Record<string, unknown>)["name"]).toBeUndefined();
    expect((tree as Record<string, unknown>)["status"]).toBeUndefined();
  });

  // FR-PLAN-0040 — plan summary previous_version is null on first create (FR-PLAN-0010)
  it("plan.previous_version is null on first create (FR-PLAN-0010)", async () => {
    const file = planFile();
    const result = await cmdCreate(file, { name: "My Plan" });

    expect(result.ok).toBe(true);
    const tree = result.result as PlanWriteResult;
    // FR-PLAN-0040 — previous_version is null on first create, surfaced in plan summary
    expect(tree.plan.previous_version).toBeNull();
    // No previous_version at result root level
    expect((tree as Record<string, unknown>)["previous_version"]).toBeUndefined();

    // FR-PLAN-0017 — plan FILE on disk has previous_version=null on first create
    const plan = loadPlan(file)!;
    expect(plan.previous_version).toBeNull();
  });

  // FR-PLAN-0026 — plan file is pretty-formatted on disk
  it("plan file is pretty-formatted on disk (2-space indent)", async () => {
    const file = planFile();
    await cmdCreate(file, { name: "Pretty Plan" });

    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, "utf8");
    // Pretty-formatted: starts with { and has newlines
    expect(raw.trim()).toMatch(/^\{/);
    expect(raw).toContain("\n");
  });

  // FR-PLAN-0040 — phases in compressed-tree carry only id, name, status, steps
  it("creates plan with phases and steps in compressed-tree", async () => {
    const file = planFile();
    const data = {
      name: "Full Plan",
      description: "test",
      phases: [
        {
          id: "p1",
          name: "Phase 1",
          description: "first",
          steps: [
            { id: "s1", name: "Step 1", prompt: "Do it" },
          ],
        },
      ],
    };
    const result = await cmdCreate(file, data);
    expect(result.ok).toBe(true);
    const tree = result.result as PlanWriteResult;

    expect(tree.phases.length).toBe(1);
    const phase = tree.phases[0]!;
    expect(phase.id).toBe("p1");
    expect(phase.name).toBe("Phase 1");
    expect(phase.status).toBe("open");
    expect(phase.steps.length).toBe(1);
    expect(phase.steps[0]!.id).toBe("s1");
    expect(phase.steps[0]!.status).toBe("open");

    // No extra fields on compressed-tree phase
    expect((phase as Record<string, unknown>)["description"]).toBeUndefined();

    // Plan still on disk correctly
    const plan = loadPlan(file);
    expect(plan).not.toBeNull();
    expect(plan!.phases.length).toBe(1);
    expect(plan!.phases[0]!.steps.length).toBe(1);
    expect(plan!.phases[0]!.steps[0]!.status).toBe("open");
  });

  it("defaults name to Unnamed Plan when missing", async () => {
    const file = planFile();
    const result = await cmdCreate(file, {});
    expect(result.ok).toBe(true);
    const tree = result.result as PlanWriteResult;
    expect(tree.plan.name).toBe("Unnamed Plan");
  });

  it.each(["", "   ", 123, {}])("rejects an invalid plan name %#", async (name) => {
    const file = planFile();
    const result = await cmdCreate(file, { name });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("size_limit_exceeded");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects plan with duplicate ids", async () => {
    const file = planFile();
    const data = {
      name: "Dup",
      phases: [
        {
          id: "p1",
          name: "P1",
          description: "",
          steps: [
            { id: "s1", name: "S1", prompt: "x" },
            { id: "s1", name: "S1 dup", prompt: "y" },
          ],
        },
      ],
    };
    const result = await cmdCreate(file, data);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("duplicate_id");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects plan with unknown dependency", async () => {
    const file = planFile();
    const data = {
      name: "Bad Deps",
      phases: [
        {
          id: "p1",
          name: "P1",
          description: "",
          steps: [
            { id: "s1", name: "S1", prompt: "x", depends_on: ["nonexistent"] },
          ],
        },
      ],
    };
    const result = await cmdCreate(file, data);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown_dependency");
  });

  it("rejects plan with cyclic dependencies", async () => {
    const file = planFile();
    const data = {
      name: "Cycle",
      phases: [
        {
          id: "p1",
          name: "P1",
          description: "",
          depends_on: ["p1"], // self-cycle
          steps: [],
        },
      ],
    };
    const result = await cmdCreate(file, data);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("dependency_cycle");
  });

  it("sets timestamps on created plan", async () => {
    const file = planFile();
    const before = Date.now();
    await cmdCreate(file, { name: "Time Test" });
    const after = Date.now();
    const plan = loadPlan(file)!;
    const created = new Date(plan.created_at).getTime();
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
  });

  it("propagates status after creation", async () => {
    const file = planFile();
    const data = {
      name: "Status Test",
      phases: [
        {
          id: "p1",
          name: "P1",
          description: "",
          steps: [{ id: "s1", name: "S1", prompt: "x" }],
        },
      ],
    };
    const result = await cmdCreate(file, data);
    expect(result.ok).toBe(true);
    const tree = result.result as PlanWriteResult;
    expect(tree.plan.status).toBe("open");
    expect(tree.phases[0]!.status).toBe("open");
  });

  it("creates parent directories if needed", async () => {
    const nested = path.join(tmpDir, "sub", "dir", "plan.json");
    const result = await cmdCreate(nested, { name: "Nested" });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("creates plan with phases that have no steps field", async () => {
    const file = planFile();
    const data = {
      name: "No Steps Phase",
      phases: [
        {
          id: "p1",
          name: "Phase Without Steps",
          description: "",
          // no 'steps' field
        },
      ],
    };
    const result = await cmdCreate(file, data);
    expect(result.ok).toBe(true);
    const plan = loadPlan(file)!;
    expect(plan.phases[0]!.steps).toEqual([]);
  });

  // A2/FR-PLAN-0024 — `plan create` on an existing path now routes through the same
  // atomicWriteWithBackup cycle as `upsert` (so a plan is never silently overwritten without a
  // backup). A directory used as the plan path is not ENOENT, so readDocWithRetry's read
  // failure is treated as a genuine corrupted-document read (EISDIR), not a raw internal_error —
  // this used to throw synchronously from a direct fs.writeFileSync instead.
  it("plan_file_corrupted: directory-as-plan-path routes through the backup cycle's read, not a raw throw", async () => {
    const dirPath = path.join(tmpDir, "dir-not-file");
    fs.mkdirSync(dirPath, { recursive: true });
    const result = await cmdCreate(dirPath, { name: "Fail" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_file_corrupted");
  });

  it("internal_error: returns internal_error for non-Error thrown (first-create path)", async () => {
    const file = planFile("bigint.json");
    // A value JSON.stringify cannot serialize makes savePlan's direct first-create write throw,
    // which cmdCreate's outer catch turns into an internal_error.
    const data = { name: "Fail", phases: [{ id: "p1", name: "P1", weird: 10n }] };
    const result = await cmdCreate(file, data as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("internal_error");
  });

  // R4 — `plan create` on an existing but corrupted/truncated plan file must still succeed: the
  // corrupted bytes are backed up (.bakNNN) and previous_version is set, under the same
  // rename-as-guard lock as upsert. Before the fix, atomicWriteWithBackup's read step always
  // returned plan_file_corrupted for a JSON parse failure, so a truncated plan.json could never
  // be recreated by `plan create` again.
  it("R4: recreates a corrupted existing plan file, backing up the corrupted bytes", async () => {
    const file = planFile();
    fs.writeFileSync(file, "{{not valid json{{");

    const result = await cmdCreate(file, { name: "Recreated Plan" });
    expect(result.ok).toBe(true);
    const tree = result.result as PlanWriteResult;
    expect(tree.plan.name).toBe("Recreated Plan");
    // previous_version points at a backup of the corrupted content, not null
    expect(tree.plan.previous_version).not.toBeNull();
    expect(tree.plan.previous_version).toMatch(/\.bak\d+$/);

    // The new plan file on disk is valid and holds the new content
    const plan = loadPlan(file)!;
    expect(plan.name).toBe("Recreated Plan");
    expect(plan.previous_version).toBe(tree.plan.previous_version);

    // The corrupted bytes were preserved in the backup file, not discarded
    const backupContent = fs.readFileSync(plan.previous_version!, "utf8");
    expect(backupContent).toBe("{{not valid json{{");
  });

  // R5 — the first-create path must go through the same `.lock` mutex as upsert/specs
  // (createDocExclusive), not an unlocked existsSync+savePlan pair. A true two-process race
  // against that unlocked pair only has a nanosecond-scale window (a single synchronous branch
  // with no interleaving point), so it can't be reproduced reliably by racing two real writers.
  // Instead this asserts the mechanism directly and deterministically: with another writer's
  // `.lock` directory already held, a lock-respecting first-create must not be able to write
  // until that lock is released, whereas the old unlocked `fs.existsSync` check does not consult
  // the lock file at all and would write immediately, ignoring it.
  it("R5: first-create respects the `.lock` mutex like upsert/specs (does not write while it is externally held)", async () => {
    const file = planFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lockPath = file + ".lock";
    fs.mkdirSync(lockPath); // simulate another writer already mid-cycle for this same path

    const releaseAfterMs = 200;
    const releaseTimer = setTimeout(() => fs.rmdirSync(lockPath), releaseAfterMs);
    try {
      const start = Date.now();
      const result = await cmdCreate(file, { name: "Waits For Lock" });
      const elapsed = Date.now() - start;

      expect(result.ok).toBe(true);
      // Must not have written before the external holder released the lock: the old unlocked
      // existsSync+savePlan path ignores `.lock` entirely and would complete in a few ms.
      expect(elapsed).toBeGreaterThanOrEqual(releaseAfterMs - 20);
      expect(loadPlan(file)!.name).toBe("Waits For Lock");
    } finally {
      clearTimeout(releaseTimer);
      try {
        fs.rmdirSync(lockPath);
      } catch {
        // already released by the timer — fine
      }
    }
  });

  it("idempotent: second create overwrites with new name (NFR-REL-0002)", async () => {
    const file = planFile();

    const first = await cmdCreate(file, { name: "Original Plan" });
    expect(first.ok).toBe(true);
    expect((first.result as PlanWriteResult).plan.name).toBe("Original Plan");

    const second = await cmdCreate(file, { name: "Replaced Plan" });
    expect(second.ok).toBe(true);
    expect((second.result as PlanWriteResult).plan.name).toBe("Replaced Plan");

    const plan = loadPlan(file)!;
    expect(plan.name).toBe("Replaced Plan");
  });
});
