// Implements FR-HELP-0002 help content for the doctor command.

import { doctorSchemasDict } from "./schemas.js";

export const doctorNotes: string[] = [
  "doctor is read-only: it never writes, modifies, or deletes any file, and it makes no network call",
  "a 'fail'-status check is a reported finding, not a tool-execution error — the envelope's ok is true whenever the scan itself completed",
  "install.<ide> at status warn means no standalone install was detected under root, which is expected for marketplace or MCP mode — it is not necessarily a problem",
  "plan.<name> checks reuse the same schema validator the plan command runs on write, applied here read-only",
  "compliance:true adds a compliance report with one combined_hash per detected install, bounded to the first 5000 files per install",
];

export const doctorHelpContent = {
  name: "doctor",
  brief: "Local, read-only health report: plugin installs, workspace files, plan files, hooks",
  description:
    "Scans a target repository for Rosetta standalone plugin installs, the workspace bootstrap files, " +
    "plans/*/plan.json health, and hook registration, and returns a structured check list. Zero network calls.",
  schemas: doctorSchemasDict,
  notes: doctorNotes,
};
