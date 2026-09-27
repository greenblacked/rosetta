// Implements FR-DOC-0001 (named result types for the doctor command).

/** FR-DOC-0001 — one reported finding. `fix` is empty when status is "ok". */
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  detail: string;
  fix: string;
}

export interface DoctorSummary {
  ok_count: number;
  warn_count: number;
  fail_count: number;
}

/** FR-DOC-0006 — one detected install's compliance data. `file_count`/`combined_hash` cover only
 * Rosetta-owned files (never a user's own files that happen to sit under the install directory).
 * `skipped_large_files` names files over the per-file size cap (not hashed, not fatal);
 * `unreadable_files` names files that could not be read (also not fatal to the run). */
export interface DoctorComplianceInstall {
  ide: string;
  version: string;
  root: string;
  file_count: number;
  truncated: boolean;
  combined_hash: string;
  skipped_large_files: string[];
  unreadable_files: string[];
}

export interface DoctorComplianceReport {
  generated_at: string;
  installs: DoctorComplianceInstall[];
}

export interface DoctorResult {
  root: string;
  checks: DoctorCheck[];
  summary: DoctorSummary;
  compliance?: DoctorComplianceReport;
}

export function buildSummary(checks: DoctorCheck[]): DoctorSummary {
  const summary: DoctorSummary = { ok_count: 0, warn_count: 0, fail_count: 0 };
  for (const c of checks) {
    if (c.status === "ok") summary.ok_count++;
    else if (c.status === "warn") summary.warn_count++;
    else summary.fail_count++;
  }
  return summary;
}
