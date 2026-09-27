// Implements FR-DOC-0002 (plugin install detection), FR-DOC-0003 (workspace file presence),
// FR-DOC-0004 (plan file health), FR-DOC-0005 (hook registration presence). Read-only: every
// function here only reads files under `root`; none writes, deletes, or executes anything
// (FR-DOC-0007).

import * as fs from "fs";
import * as path from "path";
import type { Plan } from "../plan/core.js";
import { validateUniqueIds, validateDependencies, validateSizeLimits } from "../plan/core.js";
import { PLAN_BACKUP_RETENTION } from "../../shared/constants.js";
import { DOCTOR_MAX_PLAN_FILES } from "../../shared/constants.js";
import type { DoctorCheck } from "./output.js";

// ---------------------------------------------------------------------------
// FR-DOC-0002 — standalone plugin install detection (PLUGINS.md marker paths)
// ---------------------------------------------------------------------------

interface PluginMarker {
  ide: string;
  manifestPath: string; // relative to root
  installDir: string; // relative to root — the directory the install lives under
  hooksPath: string; // relative to root
}

const PLUGIN_MARKERS: PluginMarker[] = [
  { ide: "cursor", manifestPath: "plugin.json", installDir: ".cursor", hooksPath: path.join(".cursor", "hooks.json") },
  { ide: "copilot", manifestPath: "plugin.json", installDir: ".github", hooksPath: path.join(".github", "hooks", "hooks.json") },
  {
    ide: "antigravity",
    manifestPath: path.join(".agents", "plugins", "rosetta", "plugin.json"),
    installDir: path.join(".agents", "plugins", "rosetta"),
    hooksPath: path.join(".agents", "plugins", "rosetta", "hooks.json"),
  },
  {
    ide: "codex",
    manifestPath: path.join(".codex-plugin", "plugin.json"),
    installDir: ".codex-plugin",
    hooksPath: path.join(".codex-plugin", "hooks.json"),
  },
];

export interface DetectedInstall {
  ide: string;
  version: string;
  installDirAbs: string;
  hooksPathAbs: string;
}

function readJsonSafe(absPath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(absPath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isDir(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** FR-DOC-0002 — detects standalone installs under `root`, restricted to `ideFilter` when given. */
export function detectInstalls(root: string, ideFilter?: string[]): { checks: DoctorCheck[]; installs: DetectedInstall[] } {
  const checks: DoctorCheck[] = [];
  const installs: DetectedInstall[] = [];
  const wanted = ideFilter && ideFilter.length > 0 ? new Set(ideFilter.map((i) => i.toLowerCase())) : null;

  for (const marker of PLUGIN_MARKERS) {
    if (wanted && !wanted.has(marker.ide)) continue;
    const manifestAbs = path.join(root, marker.manifestPath);
    const installDirAbs = path.join(root, marker.installDir);
    const manifest = isDir(installDirAbs) ? readJsonSafe(manifestAbs) : null;
    const name = manifest && typeof manifest["name"] === "string" ? (manifest["name"] as string) : "";
    const detected = !!manifest && (/rosetta/i.test(name) || /^core-/i.test(name));

    if (detected) {
      const version = manifest && typeof manifest["version"] === "string" ? (manifest["version"] as string) : "";
      checks.push({
        id: `install.${marker.ide}`,
        status: "ok",
        detail: `Rosetta ${marker.ide} standalone install detected, version ${version || "unknown"}`,
        fix: "",
      });
      installs.push({
        ide: marker.ide,
        version,
        installDirAbs,
        hooksPathAbs: path.join(root, marker.hooksPath),
      });
    } else {
      checks.push({
        id: `install.${marker.ide}`,
        status: "warn",
        detail: `No Rosetta ${marker.ide} standalone install detected under root (expected for marketplace or MCP mode)`,
        fix: `See PLUGINS.md for the ${marker.ide} standalone installation steps if one was expected here`,
      });
    }
  }

  // FR-DOC-0002 — duplicate installs: a Cursor standalone install alongside a vendored Claude
  // Code marketplace manifest, the exact case PLUGINS.md documents as producing duplicate tools.
  const cursorInstalled = installs.some((i) => i.ide === "cursor");
  if (cursorInstalled && fs.existsSync(path.join(root, ".claude-plugin", "plugin.json"))) {
    checks.push({
      id: "install.duplicate",
      status: "warn",
      detail: "A Cursor standalone install and a Claude Code plugin manifest were both found under root",
      fix: "Cursor auto-detects Claude Code plugins; remove the standalone install or disable Claude Code plugin pickup in Cursor Settings to avoid duplicate tools/context",
    });
  }

  return { checks, installs };
}

// ---------------------------------------------------------------------------
// FR-DOC-0003 — workspace file presence (instructions/r3/core/skills/load-project-context)
// ---------------------------------------------------------------------------

const WORKSPACE_FILES: readonly string[] = [
  "gain.json",
  "docs/CONTEXT.md",
  "docs/ARCHITECTURE.md",
  "docs/TODO.md",
  "docs/ASSUMPTIONS.md",
  "docs/TECHSTACK.md",
  "docs/DEPENDENCIES.md",
  "docs/CODEMAP.md",
  "agents/IMPLEMENTATION.md",
  "agents/MEMORY.md",
];

function slug(relPath: string): string {
  return path.basename(relPath).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** FR-DOC-0003 */
export function checkWorkspaceFiles(root: string): DoctorCheck[] {
  return WORKSPACE_FILES.map((relPath) => {
    const present = fs.existsSync(path.join(root, relPath));
    return {
      id: `workspace.${slug(relPath)}`,
      status: present ? "ok" : "warn",
      detail: present ? `${relPath} is present` : `${relPath} was not found under root`,
      fix: present ? "" : `Create ${relPath}, or run the init-workspace workflow to generate the Rosetta workspace files`,
    } as DoctorCheck;
  });
}

// ---------------------------------------------------------------------------
// FR-DOC-0004 — plan file health
// ---------------------------------------------------------------------------

function listPlanDirs(plansRoot: string): string[] {
  try {
    return fs
      .readdirSync(plansRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .slice(0, DOCTOR_MAX_PLAN_FILES);
  } catch {
    return [];
  }
}

/** FR-DOC-0004 */
export function checkPlanHealth(root: string): DoctorCheck[] {
  const plansRoot = path.join(root, "plans");
  if (!isDir(plansRoot)) {
    return [{ id: "plan.none", status: "ok", detail: "No plans/ directory found", fix: "" }];
  }

  const checks: DoctorCheck[] = [];
  const planDirs = listPlanDirs(plansRoot);
  let totalBackups = 0;

  for (const dirName of planDirs) {
    const dirAbs = path.join(plansRoot, dirName);
    const planFileAbs = path.join(dirAbs, "plan.json");

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dirAbs);
    } catch {
      entries = [];
    }
    totalBackups += entries.filter((e) => /^plan\.json\.bak\d+$/.test(e)).length;

    if (!fs.existsSync(planFileAbs)) continue; // a plan dir with no plan.json is not this check's concern

    let raw: string;
    try {
      raw = fs.readFileSync(planFileAbs, "utf8");
    } catch (e) {
      checks.push({
        id: `plan.${dirName}`,
        status: "fail",
        detail: `plans/${dirName}/plan.json could not be read: ${e instanceof Error ? e.message : String(e)}`,
        fix: "Verify file permissions and re-run",
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      checks.push({
        id: `plan.${dirName}`,
        status: "fail",
        detail: `plans/${dirName}/plan.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        fix: "Restore from the most recent plan.json.bakNNN backup, or fix the JSON by hand",
      });
      continue;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      checks.push({
        id: `plan.${dirName}`,
        status: "fail",
        detail: `plans/${dirName}/plan.json does not parse to a plan document object`,
        fix: "Restore from the most recent plan.json.bakNNN backup",
      });
      continue;
    }

    const plan = parsed as Plan;
    const error = validateUniqueIds(plan) ?? validateDependencies(plan) ?? validateSizeLimits(plan);
    if (error) {
      checks.push({
        id: `plan.${dirName}`,
        status: "fail",
        detail: `plans/${dirName}/plan.json failed validation: ${error}`,
        fix: "Fix the plan via the plan command's upsert subcommand, or restore a backup",
      });
    } else {
      checks.push({ id: `plan.${dirName}`, status: "ok", detail: `plans/${dirName}/plan.json is valid`, fix: "" });
    }
  }

  checks.push({
    id: "plan.backups",
    status: totalBackups > PLAN_BACKUP_RETENTION ? "warn" : "ok",
    detail: `${totalBackups} plan backup file(s) found across plans/*/ (retention: ${PLAN_BACKUP_RETENTION})`,
    fix:
      totalBackups > PLAN_BACKUP_RETENTION
        ? "More backups than the retention constant are present; this is expected only if backup pruning was interrupted — safe to remove the oldest plan.json.bakNNN files"
        : "",
  });

  return checks;
}

// ---------------------------------------------------------------------------
// FR-DOC-0005 — hook registration presence
// ---------------------------------------------------------------------------

/** Best-effort extraction of `.js` bundle paths referenced from a hooks.json `command` string,
 * resolving the `${CLAUDE_PLUGIN_DIR}`-style macro to `installDirAbs`. Paths we cannot resolve
 * with confidence (no recognized macro, no relative form) are left out rather than guessed at. */
function extractReferencedBundles(hooksDoc: Record<string, unknown>, installDirAbs: string): string[] {
  const found: string[] = [];
  const macroRe = /\$\{[A-Z_]+\}/g;
  const jsPathRe = /(["'])((?:(?!\1).)*\.js)\1/g;

  function walk(node: unknown): void {
    if (typeof node === "string") {
      let m: RegExpExecArray | null;
      jsPathRe.lastIndex = 0;
      while ((m = jsPathRe.exec(node)) !== null) {
        const raw = m[2]!;
        const resolved = raw.replace(macroRe, installDirAbs);
        found.push(path.isAbsolute(resolved) ? resolved : path.join(installDirAbs, resolved));
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const value of Object.values(node)) walk(value);
    }
  }

  walk(hooksDoc);
  return found;
}

/** FR-DOC-0005 */
export function checkHooks(installs: DetectedInstall[]): DoctorCheck[] {
  return installs.map((install) => {
    if (!fs.existsSync(install.hooksPathAbs)) {
      return {
        id: `hooks.${install.ide}`,
        status: "warn",
        detail: `No hooks.json found for the ${install.ide} install (deterministic hooks are opt-in)`,
        fix: "",
      } as DoctorCheck;
    }
    const doc = readJsonSafe(install.hooksPathAbs);
    if (!doc) {
      return {
        id: `hooks.${install.ide}`,
        status: "fail",
        detail: `hooks.json for the ${install.ide} install could not be parsed as JSON`,
        fix: "Regenerate the plugin, or repair hooks.json by hand",
      } as DoctorCheck;
    }
    const referenced = extractReferencedBundles(doc, install.installDirAbs);
    const missing = referenced.filter((p) => !fs.existsSync(p));
    if (missing.length > 0) {
      return {
        id: `hooks.${install.ide}`,
        status: "fail",
        detail: `hooks.json for the ${install.ide} install references ${missing.length} bundle file(s) that do not exist`,
        fix: "Re-extract or regenerate the plugin so its hook bundles are present",
      } as DoctorCheck;
    }
    return {
      id: `hooks.${install.ide}`,
      status: "ok",
      detail: `hooks.json for the ${install.ide} install is present and every referenced bundle resolves`,
      fix: "",
    } as DoctorCheck;
  });
}
