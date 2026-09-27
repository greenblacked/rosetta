// Implements FR-DOC-0006 (--compliance: per-install file checksums + machine-readable summary).
// Read-only, bounded, no network (FR-DOC-0007).

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  DOCTOR_EXCLUDED_DIRS,
  DOCTOR_MAX_COMPLIANCE_FILES_PER_INSTALL,
  DOCTOR_MAX_COMPLIANCE_FILE_SIZE_BYTES,
} from "../../shared/constants.js";
import type { DetectedInstall } from "./detectors.js";
import type { DoctorComplianceInstall, DoctorComplianceReport } from "./output.js";

// FR-DOC-0006 review finding — hashing must be restricted to files Rosetta itself ships under an
// install directory, not every file a user happens to keep there (e.g. a target repo's own
// `.github/workflows/*.yml`, or unrelated files under `.cursor/`). These are the subdirectory and
// top-level file names the standalone install layouts actually ship (see
// plugins/core-copilot-standalone/.github/ and plugins/core-cursor-standalone/.cursor/): agents,
// commands, configure, hooks, instructions, prompts, rules, skills, plus the top-level hooks.json.
const ROSETTA_OWNED_TOP_LEVEL_DIRS: ReadonlySet<string> = new Set([
  "agents",
  "commands",
  "configure",
  "hooks",
  "instructions",
  "prompts",
  "rules",
  "skills",
]);
const ROSETTA_OWNED_TOP_LEVEL_FILES: ReadonlySet<string> = new Set(["hooks.json"]);

/** True when `relPath` (forward-slash, relative to an install directory) names a file Rosetta
 * itself ships — a file directly under one of the recognized subdirectories, or a recognized
 * top-level file — rather than a user's own file that happens to sit alongside the install. */
export function isRosettaOwnedRelPath(relPath: string): boolean {
  const firstSegment = relPath.split("/")[0]!;
  if (ROSETTA_OWNED_TOP_LEVEL_DIRS.has(firstSegment)) return true;
  return !relPath.includes("/") && ROSETTA_OWNED_TOP_LEVEL_FILES.has(relPath);
}

export function listFilesBounded(root: string, maxFiles: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;

  function walk(dir: string): void {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (DOCTOR_EXCLUDED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  walk(root);
  return { files, truncated };
}

/** Reads and hashes one file, never throwing — an unreadable file (permissions, a broken
 * symlink, a race where it disappears between listing and reading) is reported back as `null`
 * rather than failing the whole compliance run (FR-DOC-0006 review finding). */
function sha256FileSafe(absPath: string): string | null {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/** FR-DOC-0006 — one install's compliance entry: per-file hashes of Rosetta-owned files, reduced
 * to one combined_hash (SHA-256 of the newline-joined, path-sorted "<relative-path> <sha256>"
 * lines). Restricted to files Rosetta itself ships (isRosettaOwnedRelPath); a file over the
 * per-file size cap is skipped (recorded in `skipped_large_files`, not hashed) and a file that
 * cannot be read is recorded in `unreadable_files` — neither fails the run. */
export function buildComplianceInstall(install: DetectedInstall): DoctorComplianceInstall {
  const { files, truncated } = listFilesBounded(install.installDirAbs, DOCTOR_MAX_COMPLIANCE_FILES_PER_INSTALL);

  const lines: string[] = [];
  const skippedLargeFiles: string[] = [];
  const unreadableFiles: string[] = [];

  for (const abs of files) {
    const rel = path.relative(install.installDirAbs, abs).split(path.sep).join("/");
    if (!isRosettaOwnedRelPath(rel)) continue;

    let size: number;
    try {
      size = fs.statSync(abs).size;
    } catch {
      unreadableFiles.push(rel);
      continue;
    }
    if (size > DOCTOR_MAX_COMPLIANCE_FILE_SIZE_BYTES) {
      skippedLargeFiles.push(rel);
      continue;
    }

    const hash = sha256FileSafe(abs);
    if (hash === null) {
      unreadableFiles.push(rel);
      continue;
    }
    lines.push(`${rel} ${hash}`);
  }
  lines.sort();
  skippedLargeFiles.sort();
  unreadableFiles.sort();
  const combined = crypto.createHash("sha256").update(lines.join("\n")).digest("hex");

  return {
    ide: install.ide,
    version: install.version,
    root: install.installDirAbs,
    file_count: lines.length,
    truncated,
    combined_hash: combined,
    skipped_large_files: skippedLargeFiles,
    unreadable_files: unreadableFiles,
  };
}

/** FR-DOC-0006 */
export function buildComplianceReport(installs: DetectedInstall[]): DoctorComplianceReport {
  return {
    generated_at: new Date().toISOString(),
    installs: installs.map(buildComplianceInstall),
  };
}
