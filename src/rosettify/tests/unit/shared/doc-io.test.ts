/**
 * Unit tests for doc-io.ts — readDocWithRetry and atomicWriteWithBackup.
 * Implements FR-SHRD-0009 (read resilience) and FR-PLAN-0024 (atomic write with rename-as-guard).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readDocWithRetry, atomicWriteWithBackup, createDocExclusive, writeDocAtomic } from "../../../src/shared/doc-io.js";
import type { Plan } from "../../../src/commands/plan/core.js";
import { savePlan } from "../../../src/commands/plan/core.js";

// Node's built-in "fs" is a frozen ESM namespace — vi.spyOn can't redefine its properties
// directly. Re-exporting a plain (spy-able) object via vi.mock is the standard workaround,
// letting individual tests below spy on mkdirSync/statSync/renameSync to simulate lock
// contention and rename failures without touching real concurrency/timing.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-planio-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function planFile(name = "plan.json"): string {
  return path.join(tmpDir, name);
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    name: "Test Plan",
    description: "",
    status: "open",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    previous_version: null,
    phases: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// readDocWithRetry — FR-SHRD-0009
// ---------------------------------------------------------------------------

describe("readDocWithRetry — FR-SHRD-0009 happy path", () => {
  // FR-SHRD-0009 — file exists: parse and return it
  it("reads and returns plan when file exists", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Hello Plan" }));
    const result = await readDocWithRetry<Plan>(file);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Hello Plan");
  });

  // FR-PLAN-0017 — back-compat: injects previous_version:null for legacy plans lacking the field
  it("injects previous_version:null for legacy plans without the field", async () => {
    const file = planFile();
    // Write raw JSON without previous_version field
    const legacy = {
      name: "Legacy",
      description: "",
      status: "open",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      phases: [],
    };
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
    const result = await readDocWithRetry<Plan>(file);
    expect(result).not.toBeNull();
    expect(result!.previous_version).toBeNull();
  });

  // FR-SHRD-0009 — no backup: return null immediately (no retry)
  it("returns null immediately when file missing and no backup exists", async () => {
    const file = planFile("nonexistent.json");
    const result = await readDocWithRetry<Plan>(file);
    expect(result).toBeNull();
  });

  // FR-SHRD-0009 — parse failure: throws so caller can translate to plan_file_corrupted
  it("throws on parse failure (invalid JSON)", async () => {
    const file = planFile();
    fs.writeFileSync(file, "{{not valid json{{");
    await expect(readDocWithRetry<Plan>(file)).rejects.toThrow();
  });
});

describe("readDocWithRetry — A3: ENOENT from readFileSync is treated as missing, not corrupted", () => {
  // A3/FR-SHRD-0009/FR-PLAN-0024 — the old existsSync-then-readFileSync pair left a
  // time-of-check/time-of-use gap: a concurrent writer's rename could remove the file between
  // the two calls, and a bare ENOENT from readFileSync was indistinguishable from a real parse
  // failure once the read moved past that gap. This mocks the file disappearing mid-read (no
  // backup present, so it must return null on the very next check rather than throw).
  it("treats an ENOENT thrown by readFileSync as 'file missing' and continues, not throws", async () => {
    const file = planFile("race.json");
    let calls = 0;
    vi.spyOn(fs, "readFileSync").mockImplementation((() => {
      calls++;
      const e = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    }) as never);

    const result = await readDocWithRetry<Plan>(file);
    expect(result).toBeNull();
    expect(calls).toBe(1); // no backup exists, so it returns immediately without retrying
  });

  // A parse failure (JSON.parse SyntaxError has no .code) must still bubble, exactly like before.
  it("still throws for a genuine parse failure, not swallowed as ENOENT", async () => {
    const file = planFile("corrupt.json");
    fs.writeFileSync(file, "{{not valid json{{");
    await expect(readDocWithRetry<Plan>(file)).rejects.toThrow();
  });
});

describe("writeDocAtomic — A3/FR-PLAN-0024 tmp-file + rename", () => {
  it("writes the final content and leaves no .tmp-* file behind", () => {
    const file = planFile("atomic.json");
    writeDocAtomic(file, JSON.stringify({ hello: "world" }));
    expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify({ hello: "world" }));
    const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("creates the parent directory when missing", () => {
    const file = path.join(tmpDir, "nested", "deep", "doc.json");
    writeDocAtomic(file, "{}");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("cleans up the tmp file and rethrows when the rename fails", () => {
    const file = planFile("fail-atomic.json");
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated rename failure");
    });
    expect(() => writeDocAtomic(file, "{}")).toThrow("simulated rename failure");
    renameSpy.mockRestore();
    const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]); // unlinked by the catch block, not left behind
  });
});

describe("createDocExclusive — A2/FR-PLAN-0024 exclusive first-create", () => {
  interface Doc {
    name: string;
  }

  it("creates the document when the file is missing", async () => {
    const file = planFile("exclusive.json");
    const result = await createDocExclusive<Doc>(
      file,
      () => ({ name: "created" }),
      (f, doc) => fs.writeFileSync(f, JSON.stringify(doc)),
    );
    expect(result).toEqual({ created: true });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ name: "created" });
  });

  it("returns created:false without writing when the file already exists", async () => {
    const file = planFile("already-exists.json");
    fs.writeFileSync(file, JSON.stringify({ name: "original" }));
    const buildDoc = vi.fn(() => ({ name: "should-not-be-written" }));
    const result = await createDocExclusive<Doc>(file, buildDoc, (f, doc) => fs.writeFileSync(f, JSON.stringify(doc)));
    expect(result).toEqual({ created: false });
    // Original content is untouched — the caller is expected to fall through to
    // atomicWriteWithBackup instead, which owns merging against the existing document.
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ name: "original" });
  });

  it("creates the parent directory when missing (mirrors savePlan/saveSpecs)", async () => {
    const file = path.join(tmpDir, "nested", "doc.json");
    const result = await createDocExclusive<Doc>(file, () => ({ name: "x" }), (f, doc) =>
      fs.writeFileSync(f, JSON.stringify(doc)),
    );
    expect(result).toEqual({ created: true });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("re-checks existence under the lock: a file created between the lock acquire and the check is respected", async () => {
    const file = planFile("race-under-lock.json");
    const realExistsSync = fs.existsSync.bind(fs);
    let firstCheck = true;
    vi.spyOn(fs, "existsSync").mockImplementation(((p: fs.PathLike) => {
      if (p === file && firstCheck) {
        firstCheck = false;
        // Simulate another process winning the race and creating the file the instant after
        // this call takes the lock, but before it re-checks existence.
        fs.writeFileSync(file, JSON.stringify({ name: "winner" }));
        return true;
      }
      return realExistsSync(p);
    }) as never);

    const buildDoc = vi.fn(() => ({ name: "loser" }));
    const result = await createDocExclusive<Doc>(file, buildDoc, (f, doc) => fs.writeFileSync(f, JSON.stringify(doc)));
    expect(result).toEqual({ created: false });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ name: "winner" });
  });

  it("releases the lock directory after a successful create", async () => {
    const file = planFile("lock-release.json");
    await createDocExclusive<Doc>(file, () => ({ name: "x" }), (f, doc) => fs.writeFileSync(f, JSON.stringify(doc)));
    expect(fs.existsSync(file + ".lock")).toBe(false);
  });

  it("returns created:false when the lock cannot be acquired within maxRetries", async () => {
    const file = planFile("lock-busy.json");
    const lockPath = file + ".lock";
    // Simulate the lock being permanently held by another process. Only the non-recursive
    // mkdirSync(lockPath) call (the mutex itself) fails — the parent-directory
    // mkdirSync(dir, {recursive:true}) call must still succeed normally.
    const realMkdirSync = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, opts?: unknown) => {
      if (p === lockPath) {
        const e = new Error("EEXIST") as NodeJS.ErrnoException;
        e.code = "EEXIST";
        throw e;
      }
      return (realMkdirSync as (...a: unknown[]) => unknown)(p, opts);
    }) as never);
    vi.spyOn(fs, "statSync").mockReturnValue({ mtimeMs: Date.now() } as fs.Stats); // fresh lock, never stale

    const buildDoc = vi.fn(() => ({ name: "x" }));
    const result = await createDocExclusive<Doc>(file, buildDoc, (f, doc) => fs.writeFileSync(f, JSON.stringify(doc)), 2);
    expect(result).toEqual({ created: false });
    expect(buildDoc).not.toHaveBeenCalled();
  });
});

describe("readDocWithRetry — FR-SHRD-0009 retry on missing-but-bak-exists", () => {
  // FR-SHRD-0009 — file missing but backup exists: retry until file reappears.
  // We create a backup (to trigger retry), then write the actual plan file after a short
  // delay — simulating the write cycle completing while reads are retrying.
  it("retries and succeeds when file reappears after backup-triggered delay", async () => {
    const file = planFile();
    const bakFile = file + ".bak000";
    const plan = makePlan({ name: "Retry Plan" });

    // Create a backup so retry is triggered (plan file does NOT exist yet)
    savePlan(bakFile, plan);

    // After a short delay (less than one retry interval of 100ms), write the plan file
    const writeDelay = 50; // PLAN_READ_RETRY_DELAY_MS is 100ms, so we write before first retry
    const writePromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        savePlan(file, plan);
        resolve();
      }, writeDelay);
    });

    // Start read — it will see backup exists, wait 100ms, then re-check
    const [result] = await Promise.all([
      readDocWithRetry<Plan>(file),
      writePromise,
    ]);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Retry Plan");
  });

  // FR-SHRD-0009 acceptance: "Given: plan file missing AND a matching backup file exists.
  // When: a read subcommand is invoked. Then: it retries every 100 ms up to 50 times before
  // returning plan_not_found." This test covers the exhaustion-after-retries branch.
  it(
    "returns null after PLAN_READ_MAX_RETRIES when file never reappears (FR-SHRD-0009 retry exhaustion)",
    async () => {
      const file = planFile();
      const bakFile = file + ".bak000";
      const plan = makePlan({ name: "Never-Restored Plan" });

      // Create a backup so retry is triggered, but never create the plan file.
      savePlan(bakFile, plan);

      const result = await readDocWithRetry<Plan>(file);

      // After PLAN_READ_MAX_RETRIES exhausted retries, readDocWithRetry returns null.
      // Caller subcommands translate null to plan_not_found (verified in next/show-status/query tests).
      expect(result).toBeNull();
    },
    // Real-time budget for 50 retries × 100ms = ~5s; allow generous timeout for slow CI.
    20000,
  );
});

// ---------------------------------------------------------------------------
// atomicWriteWithBackup — FR-PLAN-0024
// ---------------------------------------------------------------------------

describe("atomicWriteWithBackup — FR-PLAN-0024 happy path", () => {
  // FR-PLAN-0024 — happy path: produces .bak000 on first write
  it("creates first backup with index 000 and writes new plan", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Original" }));

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "done", updated: { ...plan, name: "Updated", updated_at: new Date().toISOString() } }),
      savePlan,
    );

    expect(result.ok).toBe(true);
    expect(result.result!.backupPath).toContain(".bak000");
    expect(fs.existsSync(result.result!.backupPath!)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    // Verify backup contains previous content
    const bak = JSON.parse(fs.readFileSync(result.result!.backupPath!, "utf8")) as Plan;
    expect(bak.name).toBe("Original");

    // Verify new file has updated content
    const updated = JSON.parse(fs.readFileSync(file, "utf8")) as Plan;
    expect(updated.name).toBe("Updated");
  });

  // FR-PLAN-0024 — second write produces .bak001
  it("produces .bak001 on second write (sequential naming)", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "v0" }));

    // First write → .bak000
    await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "r1", updated: { ...plan, name: "v1", updated_at: new Date().toISOString() } }),
      savePlan,
    );

    // Second write → .bak001
    const result2 = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "r2", updated: { ...plan, name: "v2", updated_at: new Date().toISOString() } }),
      savePlan,
    );

    expect(result2.ok).toBe(true);
    expect(result2.result!.backupPath).toContain(".bak001");
    expect(fs.existsSync(file.replace(".json", ".json.bak000"))).toBe(true);
    expect(fs.existsSync(file.replace(".json", ".json.bak001"))).toBe(true);
  });

  // FR-PLAN-0024 — previous_version set correctly on written plan
  it("sets previous_version to the backup path on the written plan", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Original" }));

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, updated_at: new Date().toISOString() } }),
      savePlan,
    );

    expect(result.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, "utf8")) as Plan;
    expect(written.previous_version).toBe(result.result!.backupPath);
  });

  // FR-PLAN-0024 — retention: write 7 times, expect only 5 backups (bak002..bak006)
  it("prunes oldest backups beyond retention (write 7, keep 5)", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "v0" }));

    for (let i = 1; i <= 7; i++) {
      await atomicWriteWithBackup<Plan, string>(
        file,
        (plan) => ({ ok: true, result: `r${i}`, updated: { ...plan, name: `v${i}`, updated_at: new Date().toISOString() } }),
        savePlan,
        { retention: 5 },
      );
    }

    // After 7 writes: bak000..bak006 created. Retention=5 keeps newest 5: bak002..bak006.
    const dir = path.dirname(file);
    const basename = path.basename(file);
    const backups = fs.readdirSync(dir).filter((e) => e.startsWith(basename + ".bak"));
    expect(backups.length).toBe(5);

    // Oldest two should be pruned
    expect(fs.existsSync(file + ".bak000")).toBe(false);
    expect(fs.existsSync(file + ".bak001")).toBe(false);
    // Newest five must exist
    for (let i = 2; i <= 6; i++) {
      const padded = String(i).padStart(3, "0");
      expect(fs.existsSync(file + `.bak${padded}`)).toBe(true);
    }
  });
});

describe("atomicWriteWithBackup — FR-PLAN-0024 mutation ok:false bubbles without retry", () => {
  // FR-PLAN-0024 — mutation returning ok:false bubbles immediately without retry
  it("returns mutation error immediately without writing backup", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Original" }));

    let callCount = 0;
    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (_plan) => {
        callCount++;
        return { ok: false, error: "target_not_found" };
      },
      savePlan,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("target_not_found");
    expect(callCount).toBe(1); // no retry
    // No backup created
    const dir = path.dirname(file);
    const basename = path.basename(file);
    const backups = fs.readdirSync(dir).filter((e) => e.startsWith(basename + ".bak"));
    expect(backups.length).toBe(0);
  });
});

describe("atomicWriteWithBackup — FR-PLAN-0024 rename failure (bak slot blocked) uses next available slot", () => {
  // FR-PLAN-0024 — when bak000 slot is blocked (dir), the cycle fails the rename,
  // restarts from step 1, finds bak000 (dir) as existing, computes bak001 as next slot,
  // and succeeds. Demonstrates the retry loop finds the next available backup name.
  it("succeeds using bak001 when bak000 directory is in the way", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Original" }));

    // Pre-create .bak000 as a DIRECTORY so first rename to bak000 fails
    const bakDir = file + ".bak000";
    fs.mkdirSync(bakDir, { recursive: true });

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, name: "Updated", updated_at: new Date().toISOString() } }),
      savePlan,
      { maxRetries: 10 },
    );

    // Cleanup the directory we created (if still there)
    try { fs.rmdirSync(bakDir); } catch { /* ignore — may have been consumed */ }

    // Should have succeeded using bak001 (skipping bak000 dir)
    expect(result.ok).toBe(true);
    expect(result.result!.backupPath).toContain(".bak001");
    expect(fs.existsSync(result.result!.backupPath!)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("atomicWriteWithBackup — FR-PLAN-0024 max retries → backup_create_failed", () => {
  // FR-PLAN-0024 — exhausting retries returns backup_create_failed.
  // We simulate a permanent post-rename write failure by using a custom savePlan
  // that always throws. The write cycle: renames plan→bak, then tries to write, fails,
  // rolls back bak→plan, continues. After maxRetries attempts, returns backup_create_failed.
  it("returns backup_create_failed when all retries exhausted due to post-rename write failure", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Original" }));

    // Custom savePlan that always throws to simulate persistent write failure
    const failingSavePlan = (_filePath: string, _plan: Plan): void => {
      throw new Error("Simulated persistent write failure");
    };

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, updated_at: new Date().toISOString() } }),
      failingSavePlan,
      { maxRetries: 3 }, // 3 attempts, all fail due to write failure
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("backup_create_failed");
  });
});

describe("atomicWriteWithBackup — FR-PLAN-0024 file missing → plan_not_found", () => {
  it("returns plan_not_found when the plan file does not exist", async () => {
    const file = planFile("nonexistent.json");

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, updated_at: new Date().toISOString() } }),
      savePlan,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_not_found");
  });
});

describe("atomicWriteWithBackup — FR-PLAN-0024 corrupted plan → plan_file_corrupted", () => {
  it("returns plan_file_corrupted when existing plan has invalid JSON", async () => {
    const file = planFile();
    fs.writeFileSync(file, "{{invalid json{{");

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, updated_at: new Date().toISOString() } }),
      savePlan,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_file_corrupted");
  });
});

describe("atomicWriteWithBackup — options.errors override param (FR-SPECS-0071 — specs' own error codes)", () => {
  // specs passes its own { corrupted: specs_file_corrupted, notFound: specs_not_found } via
  // write.ts (see applyBatchWrite) instead of the plan defaults exercised by every other test in
  // this file. Exercised directly here against doc-io.ts itself, not just indirectly through a
  // specs subcommand test.
  it("uses options.errors.corrupted instead of the plan_file_corrupted default", async () => {
    const file = planFile();
    fs.writeFileSync(file, "{{invalid json{{");

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, updated_at: new Date().toISOString() } }),
      savePlan,
      { errors: { corrupted: "custom_corrupted", notFound: "custom_not_found" } },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("custom_corrupted");
  });

  it("uses options.errors.notFound instead of the plan_not_found default", async () => {
    const file = planFile("nonexistent.json");

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, updated_at: new Date().toISOString() } }),
      savePlan,
      { errors: { corrupted: "custom_corrupted", notFound: "custom_not_found" } },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("custom_not_found");
  });

  it("falls back to the plan defaults when options.errors is omitted (byte-identical plan behavior)", async () => {
    const file = planFile("nonexistent2.json");

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, updated_at: new Date().toISOString() } }),
      savePlan,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_not_found");
  });
});

// ---------------------------------------------------------------------------
// atomicWriteWithBackup — finding 3: mutatorIgnoresCurrent + missing file must not ENOENT-loop
// ---------------------------------------------------------------------------

describe("atomicWriteWithBackup — finding 3: mutatorIgnoresCurrent with a missing plan file", () => {
  // Reachable when createDocExclusive returns created:false due to lock-retry exhaustion, or the
  // file is deleted between calls. Before the fix, step 5 unconditionally renameSync'd `filePath`
  // to the backup slot even though `current` was just a `{}` placeholder for a file that does not
  // exist on disk — every attempt threw ENOENT, exhausting maxRetries into backup_create_failed.
  it("writes directly with previous_version null instead of looping to backup_create_failed", async () => {
    const file = planFile("missing.json"); // never created — simulates the race described above

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (_current) => ({
        ok: true,
        result: "created",
        updated: makePlan({ name: "Freshly Created" }),
      }),
      savePlan,
      { mutatorIgnoresCurrent: true },
    );

    expect(result.ok).toBe(true);
    expect(result.result!.backupPath).toBeNull();
    expect(fs.existsSync(file)).toBe(true);

    const written = JSON.parse(fs.readFileSync(file, "utf8")) as Plan;
    expect(written.name).toBe("Freshly Created");
    expect(written.previous_version).toBeNull();

    // No backup file of any kind should have been created — there was nothing to back up.
    const dir = path.dirname(file);
    const basename = path.basename(file);
    const backups = fs.readdirSync(dir).filter((e) => e.startsWith(basename + ".bak"));
    expect(backups.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// atomicWriteWithBackup — finding 4: mutatorIgnoresCurrent + valid non-object JSON
// ---------------------------------------------------------------------------

describe("atomicWriteWithBackup — finding 4: mutatorIgnoresCurrent with valid non-object JSON", () => {
  // Before the fix, readDocWithRetry's `"previous_version" in raw` check threw a bare TypeError
  // for these shapes (not a SyntaxError), which R4's recovery didn't recognize — so it fell
  // through to the unconditional `return err(corruptedError)`, permanently blocking a mutator
  // (like `plan create`) that never reads `current` at all.
  it.each([
    ["null", "null"],
    ["a bare number", "0"],
    ["an array", "[]"],
  ])("backs up and replaces content that parses to %s, like a SyntaxError", async (_label, raw) => {
    const file = planFile();
    fs.writeFileSync(file, raw);

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (_current) => ({ ok: true, result: "created", updated: makePlan({ name: "Replaced" }) }),
      savePlan,
      { mutatorIgnoresCurrent: true },
    );

    expect(result.ok).toBe(true);
    expect(result.result!.backupPath).not.toBeNull();
    expect(fs.existsSync(result.result!.backupPath!)).toBe(true);
    expect(fs.readFileSync(result.result!.backupPath!, "utf8")).toBe(raw);

    const written = JSON.parse(fs.readFileSync(file, "utf8")) as Plan;
    expect(written.name).toBe("Replaced");
  });

  // Without mutatorIgnoresCurrent, behavior for other commands must stay unchanged: non-object
  // JSON is reported cleanly as the caller's corrupted-error code, never an internal_error, and
  // it is not silently recovered from.
  it("still returns plan_file_corrupted (not internal_error) without mutatorIgnoresCurrent", async () => {
    const file = planFile();
    fs.writeFileSync(file, "null");

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, updated_at: new Date().toISOString() } }),
      savePlan,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("plan_file_corrupted");
  });
});

// ---------------------------------------------------------------------------
// atomicWriteWithBackup — lock-acquisition edge cases (FR-PLAN-0024 step 0a)
// ---------------------------------------------------------------------------

describe("atomicWriteWithBackup — FR-PLAN-0024 lock acquisition edge cases", () => {
  // Non-EEXIST mkdir failure (e.g. a transient EPERM/EIO) — logged as a warning and the
  // whole cycle restarts, distinct from the EEXIST "another writer holds the lock" path.
  it("retries when mkdirSync fails with a non-EEXIST error", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Original" }));

    let calls = 0;
    const realMkdirSync = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementation(((...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        const e = new Error("simulated EPERM") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      return (realMkdirSync as (...a: unknown[]) => unknown)(...args);
    }) as never);

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, name: "Updated", updated_at: new Date().toISOString() } }),
      savePlan,
      { maxRetries: 5 },
    );

    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  // EEXIST + lock not stale — a fresh lock from a concurrent writer causes a short
  // spin-wait and retry; the lock must NOT be forcibly removed.
  it("waits and retries when the lock is held but not stale", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Original" }));

    let calls = 0;
    const realMkdirSync = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementation(((...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        const e = new Error("EEXIST") as NodeJS.ErrnoException;
        e.code = "EEXIST";
        throw e;
      }
      return (realMkdirSync as (...a: unknown[]) => unknown)(...args);
    }) as never);
    vi.spyOn(fs, "statSync").mockReturnValueOnce({ mtimeMs: Date.now() } as fs.Stats);
    const rmdirSpy = vi.spyOn(fs, "rmdirSync");

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, name: "Updated", updated_at: new Date().toISOString() } }),
      savePlan,
      { maxRetries: 5 },
    );

    expect(result.ok).toBe(true);
    // Only the final lock release should call rmdirSync — a fresh lock must not also
    // trigger the stale-lock forced-removal call.
    expect(rmdirSpy).toHaveBeenCalledTimes(1);
  });

  // EEXIST + lock IS stale (held longer than the 30s crash-assumption window) — the stale
  // lock is forcibly removed so the cycle can make progress.
  it("removes a stale lock and retries", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Original" }));

    let calls = 0;
    const realMkdirSync = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementation(((...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        const e = new Error("EEXIST") as NodeJS.ErrnoException;
        e.code = "EEXIST";
        throw e;
      }
      return (realMkdirSync as (...a: unknown[]) => unknown)(...args);
    }) as never);
    vi.spyOn(fs, "statSync").mockReturnValueOnce({ mtimeMs: Date.now() - 40_000 } as fs.Stats);

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, name: "Updated", updated_at: new Date().toISOString() } }),
      savePlan,
      { maxRetries: 5 },
    );

    expect(result.ok).toBe(true);
  });

  // EEXIST, but the lock directory disappears between the EEXIST error and the stat call
  // (another writer released it mid-race) — statSync throws, caught harmlessly, retried.
  it("retries harmlessly when the lock disappears between EEXIST and statSync", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Original" }));

    let calls = 0;
    const realMkdirSync = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementation(((...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        const e = new Error("EEXIST") as NodeJS.ErrnoException;
        e.code = "EEXIST";
        throw e;
      }
      return (realMkdirSync as (...a: unknown[]) => unknown)(...args);
    }) as never);
    vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
      throw new Error("ENOENT: lock vanished");
    });

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, name: "Updated", updated_at: new Date().toISOString() } }),
      savePlan,
      { maxRetries: 5 },
    );

    expect(result.ok).toBe(true);
  });

  // Primary rename (plan file → bak path, step 5) fails inside the lock — warns and restarts
  // the whole cycle from step 1 (distinct from the post-rename write-failure rollback path
  // covered by the "backup_create_failed" test above).
  it("restarts the cycle when the primary rename fails", async () => {
    const file = planFile();
    savePlan(file, makePlan({ name: "Original" }));

    let calls = 0;
    const realRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation(((...args: unknown[]) => {
      calls++;
      if (calls === 1) {
        throw new Error("simulated rename failure");
      }
      return (realRenameSync as (...a: unknown[]) => unknown)(...args);
    }) as never);

    const result = await atomicWriteWithBackup<Plan, string>(
      file,
      (plan) => ({ ok: true, result: "ok", updated: { ...plan, name: "Updated", updated_at: new Date().toISOString() } }),
      savePlan,
      { maxRetries: 5 },
    );

    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
