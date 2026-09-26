// Implements FR-PLAN-0010 (create subcommand) and FR-PLAN-0040 (compressed-tree output).
// Uses FR-PLAN-0024 write cycle (first-create path: direct write, previous_version=null).

import type { RunEnvelope } from "../../registry/types.js";
import { ok, err } from "../../shared/envelope.js";
import { logger } from "../../shared/logger.js";
import { atomicWriteWithBackup, createDocExclusive } from "../../shared/doc-io.js";
import {
  type Plan,
  validateUniqueIds,
  validateDependencies,
  validateSizeLimits,
  propagateStatuses,
  savePlan,
  normalizePhase,
} from "./core.js";
import { buildPlanWriteResult, type PlanWriteResult } from "./output.js";

// FR-PLAN-0010 — create returns compressed-tree shape (FR-PLAN-0040)
export const createInputSchema = {
  type: "object" as const,
  properties: {
    plan_file: { type: "string", description: "Path to the plan JSON file" },
    data: {
      oneOf: [
        { type: "string", description: "JSON string of plan data" },
        { type: "object", description: "Plan data object" },
      ],
    },
  },
};

export const createOutputSchema = {
  $ref: "PlanWriteResult" as const,
};

export async function cmdCreate(
  planFile: string,
  data: Record<string, unknown>,
): Promise<RunEnvelope<PlanWriteResult>> {
  try {
    const now = new Date().toISOString();

    const rawPhases = Array.isArray(data["phases"])
      ? (data["phases"] as Record<string, unknown>[])
      : [];

    // A5/FR-PLAN-0001 — normalizePhase/normalizeStep are the single source of the create-time
    // defaults (status:"open", depends_on:[], steps:[], description:""), also reused by upsert
    // wherever it appends a brand-new phase or step.
    const phases = rawPhases.map((p) => normalizePhase(p));

    const plan: Plan = {
      name: (data["name"] as string | undefined) ?? "Unnamed Plan",
      description: (data["description"] as string | undefined) ?? "",
      status: "open",
      created_at: now,
      updated_at: now,
      // FR-PLAN-0010 / FR-PLAN-0017 — previous_version=null on first create
      previous_version: null,
      phases,
    };

    const uniqueErr = validateUniqueIds(plan);
    if (uniqueErr) return err(uniqueErr);

    const depsErr = validateDependencies(plan);
    if (depsErr) return err(depsErr);

    const sizeErr = validateSizeLimits(plan);
    if (sizeErr) return err(sizeErr);

    propagateStatuses(plan);

    // R5 — first-ever create must not be an unlocked `existsSync` + `savePlan` pair: two
    // concurrent `create` calls against the same missing path could both observe "missing" and
    // both write directly, the loser silently clobbering the winner with no backup at all. Take
    // the same `.lock` mutex upsert/specs use (createDocExclusive re-checks existence *inside*
    // the lock before writing) so first-create is race-free like every other write path.
    const created = await createDocExclusive<Plan>(planFile, () => plan, savePlan);
    if (created.created) {
      // FR-PLAN-0010 / FR-PLAN-0024 — first-ever create: skip the backup cycle entirely,
      // previous_version stays null.
      logger.info({ planFile, name: plan.name }, "plan created");
      // FR-PLAN-0040 — return PlanWriteResult shape (plan + phases); previous_version=null on first create (FR-PLAN-0010)
      return ok(buildPlanWriteResult(plan, null));
    }

    // createDocExclusive reports `created: false` either because the file already exists (the
    // common case — A2: `plan create` on an existing file must not silently overwrite it with no
    // recovery path) or because the lock could not be acquired within its own retry budget.
    // Either way, fall through to the same rename-as-guard write cycle as `upsert` (FR-PLAN-0024):
    // the on-disk content is backed up to a `.bakNNN` file and `previous_version` is set to it,
    // while the user-visible outcome (the file now holds this newly-built plan) is unchanged from
    // the old overwrite behavior.
    //
    // R4 — `mutatorIgnoresCurrent: true` because the mutation below never reads `_current`: it
    // always rebuilds the plan from this call's own inputs. That means a corrupted/truncated
    // plan.json at `planFile` must not permanently block `create` with `plan_file_corrupted`
    // (there would be no way to ever recreate the file again) — the corrupted bytes are instead
    // backed up like any other previous version, and previous_version is set, under the same
    // lock.
    const writeResult = await atomicWriteWithBackup<Plan, PlanWriteResult>(
      planFile,
      (_current) => ({ ok: true, result: buildPlanWriteResult(plan, null), updated: plan }),
      savePlan,
      { mutatorIgnoresCurrent: true },
    );

    if (!writeResult.ok) {
      return { ok: false, result: null, error: writeResult.error, include_help: writeResult.include_help };
    }

    const tree = writeResult.result!.result;
    const bak = writeResult.result!.backupPath;
    logger.info({ planFile, name: plan.name, backupPath: bak }, "plan created (existing file backed up)");
    return ok({ ...tree, plan: { ...tree.plan, previous_version: bak } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`internal_error: ${msg}`);
  }
}
