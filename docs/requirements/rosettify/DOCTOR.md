# FR-DOC — Doctor Command

Requirements for the `doctor` command: `npx rosettify doctor [--root <dir>] [--ide <name>...] [--compliance] [--json]`. It is a read-only local health report for a target repository the caller's Rosetta plugin was installed into — the mechanical counterpart to TROUBLESHOOTING.md's manual "ask the agent what it can do" verification step. It mirrors the shared rosettify architecture: one registry tool with one run delegate (FR-ARCH-0001, FR-ARCH-0003, FR-ARCH-0006), exposed through both CLI and MCP frontends over the same delegate (FR-ARCH-0002), returning the common output envelope (FR-ARCH-0011) transformed by the frontends (FR-ARCH-0014). Unlike `plan` and `specs`, `doctor` addresses no caller-supplied document; every check reads only files already present under `--root` (default the caller's current working directory) and the rosettify package's own compiled-in version. It makes zero network calls and writes to no file (NFR-SEC-class, mirrors NFR.md's zero-network posture).

## FR-DOC-0001 Doctor Run Delegate

<req id="FR-DOC-0001" type="FR" level="System">
  <title>doctor accepts root/ide/compliance/json and returns a structured check list</title>
  <statement>doctor SHALL accept an optional `root` directory (default the process's current working directory), an optional list of `ide` names to restrict plugin-install detection to (default: every known IDE), an optional `compliance` boolean (default false, FR-DOC-0006), and an optional `json` boolean accepted for caller compatibility and explicitness — CLI output is always JSON per FR-CLI-0004, so `json` SHALL NOT change the result's shape. The result SHALL be the named type `DoctorResult` = { root, checks: DoctorCheck[], summary: DoctorSummary }. `DoctorCheck` = { id, status: "ok"\|"warn"\|"fail", detail, fix }, where `id` names the specific check (FR-DOC-0002 through FR-DOC-0005), `detail` is a caller-facing description of what was found, and `fix` is a caller-facing suggestion (empty string when status is "ok"). `DoctorSummary` = { ok_count, warn_count, fail_count }, each counting the `checks` entries at that status. doctor SHALL always return `ok: true` at the envelope level when the scan itself completes — a "fail"-status check is a reported finding, not a tool-execution error (mirrors FR-SPECS-0027's trace posture) — and SHALL return an envelope error only when the scan itself cannot run (`root_not_found`: the given root does not exist or is not a directory).</statement>
  <rationale>A flat check list with a stable per-check id lets a caller (a human, an AI agent, or an MDM/CI compliance script) filter and act on individual findings without parsing prose. Returning envelope `ok: true` even when checks fail follows the same reasoning FR-SPECS-0027 already established for trace: a health report that found problems still successfully ran, and conflating "the report has bad news" with "the tool errored" would make CI's genuine pass/fail signal (`fail_count`) indistinguishable from a broken invocation.</rationale>
  <source>User</source>
  <ticketId>CTORNDGAIN-1333</ticketId>
  <priority>Must</priority>
  <status>Approved</status>
  <approved_by>isolomatov-gd</approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: doctor run against a root with no Rosetta plugin markers and no workspace files. When: executed. Then: ok:true at the envelope level; result.checks lists every check FR-DOC-0002 through FR-DOC-0005 defines, each at status "warn" or "ok" as appropriate; result.summary counts match result.checks. Given: a root path that does not exist. Then: {error: "root_not_found"}. Given: doctor with json:true. When: executed via CLI. Then: stdout is still the plain DoctorResult JSON, unchanged in shape from json:false.</criteria>
  </acceptance>
  <depends>FR-DOC-0002, FR-DOC-0003, FR-DOC-0004, FR-DOC-0005</depends>
  <implementation>Implemented</implementation>
  <implementationNotes>src/rosettify/src/commands/doctor/index.ts, core.ts, output.ts</implementationNotes>
</req>

## FR-DOC-0002 Plugin Install Detection

<req id="FR-DOC-0002" type="FR" level="System">
  <title>Detect standalone Rosetta plugin installs per IDE, their version, and duplicates</title>
  <statement>doctor SHALL check, under `root`, for the standalone plugin markers documented in PLUGINS.md: Cursor (`plugin.json` at root plus a `.cursor/` directory), GitHub Copilot (`plugin.json` at root plus a `.github/` directory carrying a `skills` or `prompts` subdirectory), Antigravity (`.agents/plugins/rosetta/plugin.json`), and Codex (`.codex-plugin/plugin.json`). A manifest SHALL be accepted as a Rosetta install only when it parses as JSON and its `name` field matches `rosetta` or starts with `core-` (case-insensitive) — a plain `plugin.json` unrelated to Rosetta SHALL NOT be reported. For each IDE named in a caller-supplied `ide` list (or every known IDE, when none is supplied), doctor SHALL report one check `install.<ide>` at status "ok" when a Rosetta install is detected (`detail` carries the manifest's `version`), "warn" when no install is detected (this is not necessarily a problem — the caller may use marketplace mode or a different IDE), and SHALL NOT report "fail" for a simple absence. Where both a Cursor standalone install and evidence that the corresponding IDE also loads Claude Code plugins are found (per ARCHITECTURE.md, Cursor auto-detects Claude Code plugins), doctor SHALL additionally report a `install.duplicate` check at status "warn" naming both locations, since PLUGINS.md documents this exact case as a source of duplicate tools and context.</statement>
  <rationale>The manifest name check guards against a false positive on an unrelated `plugin.json` a target repository might already have for its own purposes. "warn" rather than "fail" for a missing install matches F2-9's stated risk posture (heuristic detectors must not hard-fail on a layout doctor cannot fully model) and reflects that most users run in marketplace or MCP mode, where no standalone marker exists in the repository at all — its absence is informational, not a defect.</rationale>
  <source>User</source>
  <ticketId>CTORNDGAIN-1333</ticketId>
  <priority>Must</priority>
  <status>Approved</status>
  <approved_by>isolomatov-gd</approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: a root carrying `.agents/plugins/rosetta/plugin.json` with name "rosetta" and version "3.1.13". When: doctor runs. Then: install.antigravity is "ok" and its detail carries "3.1.13". Given: a root with a `plugin.json` at its root whose name is "my-own-tool" (unrelated) alongside an unrelated `.cursor/` directory. When: doctor runs. Then: install.cursor is "warn" (not falsely detected as an install). Given: a root with no plugin markers at all. When: doctor runs. Then: every install.<ide> check is "warn", none is "fail". Given: an ide filter naming only "codex". When: doctor runs. Then: only install.codex is reported among the install.* checks.</criteria>
  </acceptance>
  <implementationNotes>src/rosettify/src/commands/doctor/detectors.ts</implementationNotes>
</req>

## FR-DOC-0003 Workspace File Presence

<req id="FR-DOC-0003" type="FR" level="System">
  <title>Check presence of the Rosetta workspace files</title>
  <statement>doctor SHALL check, under `root`, for the presence of the workspace files load-project-context's bootstrap file list names as caller-visible (non-generated) artifacts: `gain.json`, `docs/CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/TODO.md`, `docs/ASSUMPTIONS.md`, `docs/TECHSTACK.md`, `docs/DEPENDENCIES.md`, `docs/CODEMAP.md`, `agents/IMPLEMENTATION.md`, `agents/MEMORY.md`. Each SHALL be reported as its own check `workspace.<file-slug>` (the file's basename, lowercased, with non-alphanumeric characters replaced by `-`), at status "ok" when present and "warn" when absent, with `fix` naming the missing path and, for `gain.json`, `docs/CONTEXT.md`, and `docs/ARCHITECTURE.md`, suggesting the init-workspace workflow.</statement>
  <rationale>These are the files load-project-context already treats as the project's bootstrap context; TROUBLESHOOTING/PLUGINS' manual verification asks a human to confirm the agent can see them, which is exactly a file-existence check a tool can automate. Per-file checks (rather than one aggregate) let a caller see precisely which piece of context is missing.</rationale>
  <source>User</source>
  <ticketId>CTORNDGAIN-1333</ticketId>
  <priority>Must</priority>
  <status>Approved</status>
  <approved_by>isolomatov-gd</approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: a root with docs/CONTEXT.md present and every other workspace file absent. When: doctor runs. Then: workspace.context-md is "ok"; every other workspace.* check is "warn" and names its missing path in fix.</criteria>
  </acceptance>
  <implementationNotes>src/rosettify/src/commands/doctor/detectors.ts</implementationNotes>
</req>

## FR-DOC-0004 Plan File Health

<req id="FR-DOC-0004" type="FR" level="System">
  <title>Validate every plans/*/plan.json and count leftover backups</title>
  <statement>doctor SHALL enumerate `plans/*/plan.json` under `root` (bounded to the first 200 matches) and, for each, attempt to parse it as JSON and validate it against the plan schema already used by the `plan` command (FR-PLAN-0017). A file that parses and validates SHALL be reported "ok"; a file that fails to parse or fails schema validation SHALL be reported "fail" with the parse or validation error in `detail`, under check id `plan.<plan-name>`. doctor SHALL also count `plans/*/plan.json.bakNNN` files under `root` and report one check `plan.backups` at status "ok" when the count is at or below the plan command's retention constant and "warn" when it exceeds it (a sign of leftover backups from an interrupted write cycle or a retention regression). When no `plans/` directory exists, doctor SHALL report `plan.none` at status "ok" with a detail stating none were found — an empty repository is not a problem.</statement>
  <rationale>Reuses the plan command's own schema validator rather than re-implementing plan-shape rules a second time (DRY) — this is the same validator the `plan` command runs against a write, applied here read-only against whatever already exists on disk. Backup-count is a workspace hygiene signal: FR-PLAN-0024's retention constant caps how many should ever accumulate under normal operation, so an excess is worth surfacing even though it never blocks anything on its own.</rationale>
  <source>User</source>
  <ticketId>CTORNDGAIN-1333</ticketId>
  <priority>Must</priority>
  <status>Approved</status>
  <approved_by>isolomatov-gd</approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: plans/checkout/plan.json holding valid plan JSON. When: doctor runs. Then: plan.checkout is "ok". Given: plans/checkout/plan.json holding invalid JSON. When: doctor runs. Then: plan.checkout is "fail" and detail names the parse failure. Given: 7 backup files for one plan while retention is 5. When: doctor runs. Then: plan.backups is "warn". Given: no plans/ directory. When: doctor runs. Then: plan.none is "ok".</criteria>
  </acceptance>
  <depends>FR-PLAN-0017, FR-PLAN-0024</depends>
  <implementationNotes>src/rosettify/src/commands/doctor/detectors.ts</implementationNotes>
</req>

## FR-DOC-0005 Hook Registration Presence

<req id="FR-DOC-0005" type="FR" level="System">
  <title>Check that a detected install's referenced hook bundle exists on disk</title>
  <statement>For each IDE where FR-DOC-0002 detects an install, doctor SHALL check whether that install's `hooks.json` (or, for Codex, `.codex-plugin/hooks.json`) is present and, when present, whether every bundle path it references resolves to a file under the install directory. This SHALL be reported as `hooks.<ide>` at status "ok" when the hooks file is present and every referenced bundle resolves, "warn" when the install has no hooks file at all (deterministic hooks are opt-in — ARCHITECTURE.md — so this is expected for most installs), and "fail" when a hooks file is present but references a bundle path that does not resolve to a file under the install directory (a broken install). doctor SHALL NOT execute any referenced bundle.</statement>
  <rationale>A hooks.json that references a missing bundle is exactly the "hook registered but its file was never synced" failure mode F2-9 names, and it is silent at runtime — the IDE simply never fires that hook, with no error anywhere a human would see. Read-only static resolution (never executing the bundle) keeps this check within doctor's zero-side-effect posture.</rationale>
  <source>User</source>
  <ticketId>CTORNDGAIN-1333</ticketId>
  <priority>Should</priority>
  <status>Approved</status>
  <approved_by>isolomatov-gd</approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: a detected Cursor install with no .cursor/hooks.json. When: doctor runs. Then: hooks.cursor is "warn". Given: a detected install whose hooks.json references a bundle file that is present. When: doctor runs. Then: hooks.<ide> is "ok". Given: a detected install whose hooks.json references a bundle file that is absent. When: doctor runs. Then: hooks.<ide> is "fail".</criteria>
  </acceptance>
  <depends>FR-DOC-0002</depends>
  <implementationNotes>src/rosettify/src/commands/doctor/detectors.ts</implementationNotes>
</req>

## FR-DOC-0006 Compliance Mode

<req id="FR-DOC-0006" type="FR" level="System">
  <title>--compliance adds file checksums and a machine-readable summary</title>
  <statement>When `compliance` is true, doctor SHALL, for every IDE install FR-DOC-0002 detected, compute a SHA-256 checksum of every file under that install's directory (bounded to the first 5000 files per install; a bound reached SHALL be reported in that install's `truncated` flag) and add to the result a `compliance` field of the named type `DoctorComplianceReport` = { generated_at (ISO8601 UTC), installs: DoctorComplianceInstall[] }, where `DoctorComplianceInstall` = { ide, version, root, file_count, truncated, combined_hash }. `combined_hash` SHALL be the SHA-256 of the newline-joined, path-sorted list of `"<relative-path> <sha256>"` entries, so two installs are byte-for-byte identical if and only if their `combined_hash` values match. `compliance` SHALL be omitted from the result when `compliance` is false (the default). This mode SHALL remain read-only and make no network call.</statement>
  <rationale>A single combined hash per install lets an MDM or CI compliance job compare a fleet install against a known-good release checksum (F3-9's fleet-verification use case) in one field, without shipping every individual file hash back to the caller by default; the full per-file basis is still reconstructable locally because the algorithm is fully specified. Bounding file count keeps a very large install from making doctor itself slow, consistent with doctor's read-only, bounded-scan posture (mirrors FR-SPECS-0027).</rationale>
  <source>User</source>
  <ticketId>CTORNDGAIN-1333</ticketId>
  <priority>Should</priority>
  <status>Approved</status>
  <approved_by>isolomatov-gd</approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: doctor run with compliance:false. When: executed. Then: result carries no compliance field. Given: doctor run with compliance:true against a root with one detected install of 3 files. When: executed. Then: result.compliance.installs has one entry with file_count 3 and a combined_hash. Given: the same install scanned twice without any file changing. When: compliance runs both times. Then: combined_hash is identical across both runs.</criteria>
  </acceptance>
  <depends>FR-DOC-0002</depends>
  <implementationNotes>src/rosettify/src/commands/doctor/compliance.ts</implementationNotes>
</req>

## FR-DOC-0007 No Network, Bounded, Read-Only

<req id="FR-DOC-0007" type="FR" level="System">
  <title>doctor never calls the network and never writes a file</title>
  <statement>doctor SHALL make no network call under any input combination and SHALL NOT create, modify, or delete any file or directory. Every directory walk it performs (workspace files, plan files, plugin-install directories, compliance checksums) SHALL be bounded in file count and SHALL exclude `node_modules`, `dist`, `build`, `out`, `coverage`, and `.git` at any depth, mirroring FR-SPECS-0027's scan posture.</statement>
  <rationale>doctor's entire value proposition is that it is safe to run against any repository, including ones a caller only has read access to, or an enterprise fleet where write access to arbitrary repositories is not something a compliance script should ever need. Bounding every walk keeps it usable on a very large monorepo without an explicit opt-out.</rationale>
  <source>User</source>
  <ticketId>CTORNDGAIN-1333</ticketId>
  <priority>Must</priority>
  <status>Approved</status>
  <approved_by>isolomatov-gd</approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: a root with a node_modules directory holding a file named plugin.json with name "rosetta". When: doctor runs. Then: that file is never inspected (excluded directory). Given: any doctor invocation. When: executed. Then: no new file or directory exists under root afterward that did not exist before.</criteria>
  </acceptance>
  <implementationNotes>src/rosettify/src/commands/doctor/detectors.ts, compliance.ts</implementationNotes>
</req>
