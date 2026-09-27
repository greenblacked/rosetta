// Implements FR-DOC-0006 (--compliance: per-install file checksums + machine-readable summary).
// Read-only, bounded, no network (FR-DOC-0007).

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { DOCTOR_EXCLUDED_DIRS, DOCTOR_MAX_COMPLIANCE_FILES_PER_INSTALL } from "../../shared/constants.js";
import type { DetectedInstall } from "./detectors.js";
import type { DoctorComplianceInstall, DoctorComplianceReport } from "./output.js";

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

function sha256File(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** FR-DOC-0006 — one install's compliance entry: per-file hashes reduced to one combined_hash
 * (SHA-256 of the newline-joined, path-sorted "<relative-path> <sha256>" lines). */
export function buildComplianceInstall(install: DetectedInstall): DoctorComplianceInstall {
  const { files, truncated } = listFilesBounded(install.installDirAbs, DOCTOR_MAX_COMPLIANCE_FILES_PER_INSTALL);
  const lines = files
    .map((abs) => {
      const rel = path.relative(install.installDirAbs, abs).split(path.sep).join("/");
      return `${rel} ${sha256File(abs)}`;
    })
    .sort();
  const combined = crypto.createHash("sha256").update(lines.join("\n")).digest("hex");

  return {
    ide: install.ide,
    version: install.version,
    root: install.installDirAbs,
    file_count: files.length,
    truncated,
    combined_hash: combined,
  };
}

/** FR-DOC-0006 */
export function buildComplianceReport(installs: DetectedInstall[]): DoctorComplianceReport {
  return {
    generated_at: new Date().toISOString(),
    installs: installs.map(buildComplianceInstall),
  };
}
