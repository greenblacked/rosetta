// FR-PLAN-0005 — authoritative values from rosetta_mcp/constants.py

export const PLAN_MAX_PHASES = 100;
export const PLAN_MAX_STEPS_PER_PHASE = 100;
export const PLAN_MAX_DEPENDENCIES_PER_ITEM = 50;
export const PLAN_MAX_STRING_LENGTH = 20_000;
export const PLAN_MAX_NAME_LENGTH = 256;

export const MAX_CONCURRENCY_RETRIES = 3; // FR-SHRD-0006

// FR-PLAN-0024 — atomic write with rename-as-guard constants
export const PLAN_BACKUP_RETENTION = 5;
export const PLAN_BACKUP_MAX_RETRIES = 50;

// FR-SHRD-0009 — read resilience constants
export const PLAN_READ_RETRY_DELAY_MS = 100;
export const PLAN_READ_MAX_RETRIES = 50;

// FR-SPECS-0007 — size limits and constants for the specs command
export const SPECS_MAX_SPECS = 10_000;
export const SPECS_MAX_DEPENDENCIES_PER_SPEC = 50;
export const SPECS_MAX_ACCEPTANCE_PER_SPEC = 50;
export const SPECS_MAX_EVIDENCE_PER_SPEC = 50;
export const SPECS_MAX_STRING_LENGTH = 20_000;
export const SPECS_MAX_NAME_LENGTH = 256;
export const SPECS_MAX_BATCH_SIZE = 500;

// FR-SPECS-0027 — trace scan bounds (mirrors the size-limit posture of FR-SPECS-0007)
export const TRACE_MAX_FILES = 20_000;
export const TRACE_MAX_FILE_SIZE_BYTES = 2_000_000;
export const TRACE_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
]);
export const TRACE_DEFAULT_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".rs",
  ".md",
  ".mdx",
];

// FR-DOC-0007 — doctor scan bounds (same exclusion set as trace)
export const DOCTOR_EXCLUDED_DIRS = TRACE_EXCLUDED_DIRS;
export const DOCTOR_MAX_PLAN_FILES = 200;
export const DOCTOR_MAX_COMPLIANCE_FILES_PER_INSTALL = 5_000;
// FR-DOC-0006 — per-file size cap for compliance hashing (mirrors TRACE_MAX_FILE_SIZE_BYTES's
// read-only bounded-scan posture); a file over this size is skipped and recorded, not hashed.
export const DOCTOR_MAX_COMPLIANCE_FILE_SIZE_BYTES = 2_000_000;

// FR-SPECS-0027 — bounds the number of directories trace's walk will descend into, independent
// of the file-count bound, so a tree with many directories but few matching files cannot make
// the scan unbounded in wall time even though TRACE_MAX_FILES alone would not stop it.
export const TRACE_MAX_DIRS = 20_000;
