// Doctor command entry point (FR-DOC-0001). Registers the ToolDef for CLI/MCP registration.
// Unlike plan/specs, doctor has no subcommands — one call, one report.

import type { ToolDef, RunEnvelope, CommandInput } from "../../registry/types.js";
import { cmdDoctor } from "./core.js";
import type { DoctorResult } from "./output.js";
import { doctorHelpContent } from "./help-content.js";
import { doctorInputSchema } from "./schemas.js";

export interface DoctorInput extends CommandInput {}

async function runDoctor(input: DoctorInput): Promise<RunEnvelope<DoctorResult>> {
  return cmdDoctor({ root: input.root, ide: input.ide, compliance: input.compliance });
}

export const doctorToolDef: ToolDef<DoctorInput, DoctorResult> = {
  name: "doctor",
  brief: "Local, read-only health report: plugin installs, workspace files, plan files, hooks",
  description:
    "Scans a target repository for Rosetta standalone plugin installs, the workspace bootstrap files, " +
    "plans/*/plan.json health, and hook registration, and returns a structured check list. Zero network calls.",
  inputSchema: doctorInputSchema,
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      result: {},
      error: { type: "string" },
      include_help: { type: "boolean" },
    },
  },
  cli: true,
  mcp: true,
  run: runDoctor,
  helpContent: doctorHelpContent as unknown as Record<string, unknown>,
};
