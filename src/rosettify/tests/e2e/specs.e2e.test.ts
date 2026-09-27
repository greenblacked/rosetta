/**
 * specs command E2E tests — spawns the built rosettify binary as a subprocess.
 * Covers a realistic flow across all 17 subcommands plus help.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosettify-e2e-specs-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function specsFile(name = "specs.json"): string {
  return path.join(tmpDir, name);
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
  json: unknown;
}

function run(args: string[], env?: Record<string, string | undefined>): SpawnResult {
  const result = spawnSync(NODE, [BIN, ...args], {
    encoding: "utf8",
    timeout: 15000,
    env: env ? { ...process.env, ...env } : process.env,
  });
  let json: unknown = null;
  const out = result.stdout ?? "";
  try {
    json = JSON.parse(out);
  } catch {
    // not JSON — acceptable for some cases
  }
  return { stdout: out, stderr: result.stderr ?? "", status: result.status, json };
}

const ITEM_1 = JSON.stringify({
  id: "FR-CHK-0001",
  type: "FR",
  title: "Cart total",
  statement: "When the cart changes, the system shall recompute the total.",
  source: "User",
  priority: "Must",
  verification: "Test",
  level: "Component",
  subsystem: "checkout",
  component: "cart",
  acceptance: [{ ears: "event", when: "an item is added", system: "the checkout service", shall: "recompute the total" }],
});

// ---------------------------------------------------------------------------
// help specs
// ---------------------------------------------------------------------------

describe("CLI — help specs", () => {
  it("rosettify help specs returns specs detail with all 17 subcommands", () => {
    const r = run(["help", "specs"]);
    expect(r.status).toBe(0);
    expect((r.json as any).ok).toBeUndefined();
    const res = r.json as { name: string; subcommands: { name: string }[]; schemas: unknown; limits: unknown; query_notation: unknown };
    expect(res.name).toBe("specs");
    expect(res.subcommands).toHaveLength(17);
    expect(res.schemas).toBeDefined();
    expect(res.limits).toBeDefined();
    expect(res.query_notation).toBeDefined();
  });

  it("rosettify specs (no subcommand) returns the same help content", () => {
    const r = run(["specs"]);
    expect(r.status).toBe(0);
    const res = r.json as { name: string };
    expect(res.name).toBe("specs");
  });
});

// ---------------------------------------------------------------------------
// info -> add -> get -> query -> validate -> approve -> update -> graph -> render
// -> delete -> restore -> purge -> migrate
// ---------------------------------------------------------------------------

describe("CLI — specs full lifecycle flow", () => {
  it("info on a nonexistent document returns specs_not_found", () => {
    const file = specsFile();
    const r = run(["specs", "info", file]);
    expect(r.status).toBe(1);
    expect((r.json as { error: string }).error).toBe("specs_not_found");
  });

  it("add creates the document and returns SpecWriteResult", () => {
    const file = specsFile();
    const r = run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    expect(r.status).toBe(0);
    expect((r.json as any).ok).toBeUndefined();
    const res = r.json as { document: { total: number; previous_version: unknown }; affected: { id: string; status: string }[] };
    expect(res.document.total).toBe(1);
    expect(res.document.previous_version).toBeNull();
    expect(res.affected).toEqual([{ id: "FR-CHK-0001", status: "Draft" }]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("info with specs present reports areas/totals/next_ids (not just the empty-document shape)", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "info", file]);
    expect(r.status).toBe(0);
    const res = r.json as {
      areas: { code: string; count: number }[];
      totals: { total: number };
      next_ids: { prefix: string; area: string; suggested: string }[];
    };
    expect(res.areas.find((a) => a.code === "CHK")!.count).toBe(1);
    expect(res.totals.total).toBe(1);
    expect(res.next_ids).toEqual([{ prefix: "FR", area: "CHK", highest: 1, suggested: "FR-CHK-0002" }]);
  });

  it("get retrieves the added spec by id, caller id not redacted", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "get", file, "FR-CHK-0001"]);
    expect(r.status).toBe(0);
    const res = r.json as { found: { id: string; title: string }[]; missing: string[] };
    expect(res.found[0]!.id).toBe("FR-CHK-0001"); // FR-SPECS-0043 — caller id passes through verbatim
    expect(res.found[0]!.title).toBe("Cart total");
    expect(res.missing).toEqual([]);
  });

  it("query with a key:value filter and a leading '-' NOT term", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r1 = run(["specs", "query", file, "type:FR"]);
    expect(r1.status).toBe(0);
    expect((r1.json as { count: number }).count).toBe(1);

    const r2 = run(["specs", "query", file, "-status:Removed"]);
    expect(r2.status).toBe(0);
    expect((r2.json as { count: number }).count).toBe(1);

    const r3 = run(["specs", "query", file, "type:NFR"]);
    expect(r3.status).toBe(0);
    expect((r3.json as { count: number }).count).toBe(0);
  });

  it("validate reports a clean scope (ok=true)", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "validate", file]);
    expect(r.status).toBe(0);
    const res = r.json as { ok: boolean; error_count: number };
    expect(res.ok).toBe(true);
    expect(res.error_count).toBe(0);
  });

  it("approve moves the spec to Approved", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "approve", file, "FR-CHK-0001"]);
    expect(r.status).toBe(0);
    const res = r.json as { updated: { id: string; status: string }[] };
    expect(res.updated).toEqual([{ id: "FR-CHK-0001", status: "Approved" }]);
  });

  it("implemented sets the implementation enum value", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const payload = JSON.stringify({ id: "FR-CHK-0001", implementation: "Implemented" });
    const r = run(["specs", "implemented", file, payload]);
    expect(r.status).toBe(0);
    const res = r.json as { updated: { id: string; implementation: string }[] };
    expect(res.updated).toEqual([{ id: "FR-CHK-0001", implementation: "Implemented" }]);
  });

  it("deprecate moves the spec to Deprecated", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "deprecate", file, "FR-CHK-0001"]);
    expect(r.status).toBe(0);
    const res = r.json as { updated: { id: string; status: string }[] };
    expect(res.updated).toEqual([{ id: "FR-CHK-0001", status: "Deprecated" }]);
  });

  it("reopen withdraws approval, moving an Approved spec back to Draft", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    run(["specs", "approve", file, "FR-CHK-0001"]);
    const r = run(["specs", "reopen", file, "FR-CHK-0001"]);
    expect(r.status).toBe(0);
    const res = r.json as { updated: { id: string; status: string }[] };
    expect(res.updated).toEqual([{ id: "FR-CHK-0001", status: "Draft" }]);
  });

  it("update on an Approved spec's statement moves it to Modified", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    run(["specs", "approve", file, "FR-CHK-0001"]);
    const patch = JSON.stringify({ id: "FR-CHK-0001", statement: "The system shall recompute totals differently." });
    const r = run(["specs", "update", file, patch]);
    expect(r.status).toBe(0);
    const res = r.json as { affected: { id: string; status: string }[] };
    expect(res.affected).toEqual([{ id: "FR-CHK-0001", status: "Modified" }]);
  });

  it("graph on the target returns dependency closures", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const dependent = JSON.stringify({
      id: "FR-CHK-0002",
      type: "FR",
      title: "Dependent",
      statement: "The system shall depend on cart total.",
      source: "User",
      priority: "Must",
      verification: "Test",
      acceptance: [{ ears: "ubiquitous", system: "the checkout service", shall: "depend on the cart total" }],
      depends_on: ["FR-CHK-0001"],
    });
    run(["specs", "add", file, dependent]);
    const r = run(["specs", "graph", file, "FR-CHK-0001"]);
    expect(r.status).toBe(0);
    const res = r.json as { dependents: string[]; cycles: unknown[] };
    expect(res.dependents).toEqual(["FR-CHK-0002"]);
    expect(res.cycles).toEqual([]);
  });

  it("render returns a markdown document containing the spec's id and title", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "render", file]);
    expect(r.status).toBe(0);
    const res = r.json as { format: string; content: string };
    expect(res.format).toBe("markdown");
    expect(res.content).toContain("FR-CHK-0001");
    expect(res.content).toContain("Cart total");
  });

  it("delete soft-removes the spec (status=Removed, retained)", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "delete", file, "FR-CHK-0001"]);
    expect(r.status).toBe(0);
    const res = r.json as { removed: string[]; missing: string[] };
    expect(res.removed).toEqual(["FR-CHK-0001"]);
    const getR = run(["specs", "get", file, "FR-CHK-0001"]);
    expect((getR.json as { found: { status: string }[] }).found[0]!.status).toBe("Removed");
  });

  it("restore brings a Removed spec back to Draft", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    run(["specs", "delete", file, "FR-CHK-0001"]);
    const r = run(["specs", "restore", file, "FR-CHK-0001"]);
    expect(r.status).toBe(0);
    const res = r.json as { updated: { id: string; status: string }[] };
    expect(res.updated).toEqual([{ id: "FR-CHK-0001", status: "Draft" }]);
  });

  it("purge without --force refuses with force_required", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "purge", file, "FR-CHK-0001"]);
    expect(r.status).toBe(1);
    expect((r.json as { error: string }).error).toBe("force_required");
  });

  it("purge --force permanently removes the spec", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "purge", file, "FR-CHK-0001", "--force"]);
    expect(r.status).toBe(0);
    const res = r.json as { purged: string[] };
    expect(res.purged).toEqual(["FR-CHK-0001"]);
    const getR = run(["specs", "get", file, "FR-CHK-0001"]);
    expect((getR.json as { missing: string[] }).missing).toEqual(["FR-CHK-0001"]);
  });

  it("migrate imports a canonical markup source into a fresh document", () => {
    const src = path.join(tmpDir, "units.md");
    fs.writeFileSync(
      src,
      `<req id="FR-CHK-0009" type="FR" level="System"
            source="User"
            priority="Must" verification="Test"
            status="Draft" approved_by="" changed="2026-03-15"
            implementation="NotStarted">
        <title>Imported</title>
        <statement>The system shall import requirement units.</statement>
        <acceptance>
          <criteria id="FR-CHK-0009.AC1" ears="ubiquitous" system="the system" shall="import the unit"/>
        </acceptance>
      </req>`,
    );
    const dest = specsFile("migrated.json");
    const r = run(["specs", "migrate", dest, src, "--system", "checkout"]);
    expect(r.status).toBe(0);
    const res = r.json as { migrated: number; skipped: unknown[] };
    expect(res.migrated).toBe(1);
    expect(res.skipped).toEqual([]);
    expect(fs.existsSync(dest)).toBe(true);
  });

  // FR-SPECS-0025 — a unit in a superseded shape is reported with a stated reason rather than
  // reconstructed by inference, and the call still succeeds.
  it("migrate skips a unit written in the superseded shape and states why", () => {
    const src = path.join(tmpDir, "old-shape.md");
    fs.writeFileSync(
      src,
      `<req id="FR-CHK-0009" type="FR">
        <title>Legacy</title><statement>The system shall import legacy specs.</statement>
        <source>User</source><priority>Must</priority><verification>Test</verification>
        <acceptance><criteria>Given: a When: b Then: c</criteria></acceptance>
      </req>`,
    );
    const dest = specsFile("migrated.json");
    const r = run(["specs", "migrate", dest, src, "--system", "checkout"]);
    expect(r.status).toBe(0);
    const res = r.json as { migrated: number; skipped: { source: string; reason: string }[] };
    expect(res.migrated).toBe(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]!.reason).toContain("rather than reconstructed by inference");
  });

  // FR-SPECS-0023 — render emits the canonical markup that migrate reads.
  it("render returns the canonical markup when format=xml", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "render", file, "--format", "xml"]);
    expect(r.status).toBe(0);
    const res = r.json as { format: string; content: string };
    expect(res.format).toBe("xml");
    expect(res.content).toContain('<req id="FR-CHK-0001"');
    expect(res.content).toContain('ears="event"');
  });
});

// ---------------------------------------------------------------------------
// actor identity (FR-SPECS-0041) — ROSETTA_ACTOR env override flows through to
// changed_by/approved_by. Never depends on the real machine's git/OS identity.
// ---------------------------------------------------------------------------

describe("CLI — specs actor identity via ROSETTA_ACTOR", () => {
  it("stamps changed_by with ROSETTA_ACTOR on add", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"], { ROSETTA_ACTOR: "e2e-actor" });
    const r = run(["specs", "get", file, "FR-CHK-0001"]);
    expect(r.status).toBe(0);
    const res = r.json as { found: { changed_by: string }[] };
    expect(res.found[0]!.changed_by).toBe("e2e-actor");
  });

  it("stamps approved_by with ROSETTA_ACTOR on approve", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"], { ROSETTA_ACTOR: "e2e-actor" });
    run(["specs", "approve", file, "FR-CHK-0001"], { ROSETTA_ACTOR: "e2e-actor" });
    const r = run(["specs", "get", file, "FR-CHK-0001"]);
    expect(r.status).toBe(0);
    const res = r.json as { found: { approved_by: string; changed_by: string }[] };
    expect(res.found[0]!.approved_by).toBe("e2e-actor");
    expect(res.found[0]!.changed_by).toBe("e2e-actor");
  });
});

// ---------------------------------------------------------------------------
// error cases / envelope shape
// ---------------------------------------------------------------------------

describe("CLI — specs error cases", () => {
  it("exits 1 for an unknown specs subcommand", () => {
    const r = run(["specs", "bogus-subcommand"]);
    expect(r.status).toBe(1);
    const payload = r.json as { error: string };
    expect(payload.error).toContain("unknown_command");
  });

  it("query returns invalid_filter for an unknown filter key", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    const r = run(["specs", "query", file, "bogus:value"]);
    expect(r.status).toBe(1);
    expect((r.json as { error: string }).error).toBe("invalid_filter");
  });

  it("add with an item missing id returns an aggregated missing_id error", () => {
    const file = specsFile();
    const badItem = JSON.stringify({ type: "FR" });
    const r = run(["specs", "add", file, badItem, "--system", "checkout"]);
    expect(r.status).toBe(1);
    expect((r.json as { error: string }).error).toContain("missing_id");
  });
});

// ---------------------------------------------------------------------------
// Multi-process concurrent first-create (A2 / FR-SPECS-0002 mirrors FR-PLAN-0024)
// ---------------------------------------------------------------------------

// A2 — `specs add --system ...` on a missing file is a first-create write. Before the fix, the
// `!fs.existsSync(file)` check and the direct `saveSpecs` write that followed it were not
// mutually exclusive: concurrent callers could all observe a missing file and each write
// directly, so only the last writer's spec survived even though every call reported success.
describe("CLI — concurrent first-create (A2 / FR-SPECS-0002)", () => {
  it("10 concurrent `specs add --system` processes against one missing file: no lost writes", async () => {
    const N = 10;
    const file = specsFile("concurrent.json");

    const { spawn } = await import("child_process");
    const exitCodes: number[] = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const id = `FR-CHK-${String(1000 + i).padStart(4, "0")}`;
        const item = JSON.stringify({
          id,
          type: "FR",
          title: `Concurrent spec ${i}`,
          statement: "When something happens, the system shall do a thing.",
          source: "User",
          priority: "Must",
          verification: "Test",
          acceptance: [{ ears: "event", when: "something happens", system: "the checkout service", shall: "do a thing" }],
        });
        const args = [BIN, "specs", "add", file, item, "--system", "checkout"];
        return new Promise<number>((resolve) => {
          const child = spawn(NODE, args, { stdio: "pipe" });
          child.on("close", (code) => resolve(code ?? -1));
        });
      }),
    );

    expect(exitCodes.every((c) => c === 0)).toBe(true);

    const finalDoc = JSON.parse(fs.readFileSync(file, "utf8")) as { specs: { id: string }[] };
    const ids = new Set(finalDoc.specs.map((s) => s.id));
    for (let i = 0; i < N; i++) {
      const id = `FR-CHK-${String(1000 + i).padStart(4, "0")}`;
      expect(ids.has(id), `lost write: ${id} reported success but not in final document`).toBe(true);
    }

    // No leftover lock directory or tmp files (A3).
    expect(fs.existsSync(file + ".lock")).toBe(false);
    const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// specs trace — FR-SPECS-0027 (CLI E2E)
// ---------------------------------------------------------------------------

describe("CLI — specs trace", () => {
  it("reports uncited, cited, and orphan ids scanning a source directory", () => {
    const file = specsFile();
    const add = run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    expect(add.status).toBe(0);
    run(["specs", "approve", file, "FR-CHK-0001"]);

    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "cart.ts"), "// implements FR-CHK-0001\n// see also FR-CHK-9999\n");

    const result = run(["specs", "trace", file, "--source", srcDir]);
    expect(result.status).toBe(0);
    const payload = result.json as {
      specs: { id: string; code_refs: unknown[] }[];
      uncited: string[];
      orphans: { id: string }[];
    };
    expect(payload.uncited).toEqual([]);
    expect(payload.specs.find((s) => s.id === "FR-CHK-0001")!.code_refs).toHaveLength(1);
    expect(payload.orphans.map((o) => o.id)).toEqual(["FR-CHK-9999"]);
  });

  it("exits 0 without --strict even when findings exist", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    run(["specs", "approve", file, "FR-CHK-0001"]);
    const result = run(["specs", "trace", file, "--source", tmpDir]);
    expect(result.status).toBe(0);
    expect((result.json as { uncited: string[] }).uncited).toEqual(["FR-CHK-0001"]);
  });

  it("exits 1 with --strict when findings exist", () => {
    const file = specsFile();
    run(["specs", "add", file, ITEM_1, "--system", "checkout"]);
    run(["specs", "approve", file, "FR-CHK-0001"]);
    const result = run(["specs", "trace", file, "--source", tmpDir, "--strict"]);
    expect(result.status).toBe(1);
  });

  it("returns specs_not_found for a missing document", () => {
    const result = run(["specs", "trace", specsFile("nope.json")]);
    expect(result.status).toBe(1);
    expect(result.json).toEqual({ error: "specs_not_found" });
  });
});
