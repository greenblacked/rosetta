// Implements FR-DOC-0001 (doctor run delegate). Read-only local health report: aggregates the
// FR-DOC-0002..0006 checks into one DoctorResult. Never writes a file, never calls the network
// (FR-DOC-0007).

import * as fs from "fs";
import type { RunEnvelope } from "../../registry/types.js";
import { ok, err } from "../../shared/envelope.js";
import { logger } from "../../shared/logger.js";
import { detectInstalls, checkWorkspaceFiles, checkPlanHealth, checkHooks } from "./detectors.js";
import { buildComplianceReport } from "./compliance.js";
import { buildSummary } from "./output.js";
import type { DoctorResult } from "./output.js";
import { ERR_ROOT_NOT_FOUND } from "./errors.js";

export interface DoctorOptions {
  root?: string;
  ide?: string[];
  compliance?: boolean;
}

export async function cmdDoctor(options: DoctorOptions = {}): Promise<RunEnvelope<DoctorResult>> {
  try {
    const root = options.root ?? process.cwd();

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return err(ERR_ROOT_NOT_FOUND);
    }
    if (!stat.isDirectory()) return err(ERR_ROOT_NOT_FOUND);

    const { checks: installChecks, installs } = detectInstalls(root, options.ide);
    const checks = [...installChecks, ...checkWorkspaceFiles(root), ...checkPlanHealth(root), ...checkHooks(installs)];

    const result: DoctorResult = {
      root,
      checks,
      summary: buildSummary(checks),
    };

    if (options.compliance) {
      result.compliance = buildComplianceReport(installs);
    }

    logger.info(
      { root, ok: result.summary.ok_count, warn: result.summary.warn_count, fail: result.summary.fail_count },
      "doctor",
    );
    return ok(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`internal_error: ${msg}`);
  }
}
