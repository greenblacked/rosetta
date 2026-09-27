// Implements FR-HELP-0002 (named schemas dict) for the doctor command. Mirrors
// commands/specs/schemas.ts's $ref-by-name convention.

const doctorCheckSchema = {
  type: "object" as const,
  description: "One reported finding",
  properties: {
    id: { type: "string" as const, description: "stable check id, e.g. install.cursor, workspace.context-md, plan.<name>, hooks.<ide>" },
    status: { type: "string" as const, enum: ["ok", "warn", "fail"] },
    detail: { type: "string" as const, description: "caller-facing description of what was found" },
    fix: { type: "string" as const, description: "caller-facing suggestion; empty when status is ok" },
  },
};

const doctorSummarySchema = {
  type: "object" as const,
  description: "Counts of checks by status",
  properties: {
    ok_count: { type: "integer" as const },
    warn_count: { type: "integer" as const },
    fail_count: { type: "integer" as const },
  },
};

const doctorComplianceInstallSchema = {
  type: "object" as const,
  description: "One detected install's compliance data",
  properties: {
    ide: { type: "string" as const },
    version: { type: "string" as const },
    root: { type: "string" as const },
    file_count: { type: "integer" as const },
    truncated: { type: "boolean" as const, description: "true when the per-install file bound was reached" },
    combined_hash: { type: "string" as const, description: "SHA-256 of the sorted \"<relative-path> <sha256>\" lines" },
  },
};

const doctorComplianceReportSchema = {
  type: "object" as const,
  description: "Present only when compliance:true",
  properties: {
    generated_at: { type: "string" as const, description: "ISO8601 UTC" },
    installs: { type: "array" as const, items: { $ref: "DoctorComplianceInstall" as const } },
  },
};

export const doctorInputSchema = {
  type: "object" as const,
  properties: {
    root: { type: "string" as const, description: "Root directory to scan (default: process cwd)" },
    ide: { type: "array" as const, items: { type: "string" as const }, description: "Restrict plugin-install detection to these IDE names (default: every known IDE)" },
    compliance: { type: "boolean" as const, description: "Add per-install file checksums and a machine-readable compliance summary" },
    json: { type: "boolean" as const, description: "Accepted for caller compatibility; CLI output is always JSON" },
  },
};

export const doctorOutputSchema = { $ref: "DoctorResult" as const };

export const doctorSchemasDict: Record<string, unknown> = {
  DoctorInput: doctorInputSchema,
  DoctorResult: {
    type: "object" as const,
    description: "Result of doctor: a local, read-only health report",
    properties: {
      root: { type: "string" as const },
      checks: { type: "array" as const, items: { $ref: "DoctorCheck" as const } },
      summary: { $ref: "DoctorSummary" as const },
      compliance: { $ref: "DoctorComplianceReport" as const },
    },
  },
  DoctorCheck: doctorCheckSchema,
  DoctorSummary: doctorSummarySchema,
  DoctorComplianceReport: doctorComplianceReportSchema,
  DoctorComplianceInstall: doctorComplianceInstallSchema,
};
