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
  <status>Draft</status>
  <approved_by></approved_by>
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
  <status>Draft</status>
  <approved_by></approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: a root carrying `.agents/plugins/rosetta/plugin.json` with name "rosetta" and version "3.1.13". When: doctor runs. Then: install.antigravity is "ok" and its detail carries "3.1.13". Given: a root with a `plugin.json` at its root whose name is "my-own-tool" (unrelated) alongside an unrelated `.cursor/` directory. When: doctor runs. Then: install.cursor is "warn" (not falsely detected as an install). Given: a root with no plugin markers at all. When: doctor runs. Then: every install.<ide> check is "warn", none is "fail". Given: an ide filter naming only "codex". When: doctor runs. Then: only install.codex is reported among the install.* checks. Given: a root carrying a Cursor standalone install (root plugin.json + .cursor/) alongside an unrelated `.github/` directory that carries neither a `skills` nor a `prompts` subdirectory (e.g. only `.github/workflows/`). When: doctor runs. Then: install.copilot is "warn", not falsely detected as an install just because `.github/` and the same root plugin.json both exist. Given: a root carrying `.github/skills/` or `.github/prompts/` alongside a matching root plugin.json. When: doctor runs. Then: install.copilot is "ok".</criteria>
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
  <status>Draft</status>
  <approved_by></approved_by>
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
  <statement>doctor SHALL enumerate `plans/*/plan.json` under `root` (bounded to the first 200 matches) and, for each, attempt to parse it as JSON and validate it against the plan schema already used by the `plan` command (FR-PLAN-0017). A file that parses and validates SHALL be reported "ok"; a file that fails to parse or fails schema validation SHALL be reported "fail" with the parse or validation error in `detail`, under check id `plan.<plan-name>`. doctor SHALL also count `plan.json.bakNNN` files per plan directory (NOT summed across `plans/*/`) and report one check `plan.backups` at status "ok" when every individual plan's backup count is at or below the plan command's retention constant, and "warn" when ANY one plan's own backup count exceeds it (a sign of leftover backups from an interrupted write cycle or a retention regression for that plan) — `detail` SHALL name each over-retention plan directory with its count; two plans each within retention SHALL NOT warn merely because their counts sum past the constant. When no `plans/` directory exists, doctor SHALL report `plan.none` at status "ok" with a detail stating none were found — an empty repository is not a problem.</statement>
  <rationale>Reuses the plan command's own schema validator rather than re-implementing plan-shape rules a second time (DRY) — this is the same validator the `plan` command runs against a write, applied here read-only against whatever already exists on disk. Backup-count is a workspace hygiene signal: FR-PLAN-0024's retention constant caps how many should ever accumulate under normal write-cycle operation for ONE plan (each plan's backups are pruned independently by the plan command), so the comparison against retention is inherently per plan, not a total across every plan directory doctor happens to enumerate — summing across plans would warn on a perfectly healthy workspace just because it manages several plans at once.</rationale>
  <source>User</source>
  <ticketId>CTORNDGAIN-1333</ticketId>
  <priority>Must</priority>
  <status>Draft</status>
  <approved_by></approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: plans/checkout/plan.json holding valid plan JSON. When: doctor runs. Then: plan.checkout is "ok". Given: plans/checkout/plan.json holding invalid JSON. When: doctor runs. Then: plan.checkout is "fail" and detail names the parse failure. Given: 7 backup files for one plan while retention is 5. When: doctor runs. Then: plan.backups is "warn" and detail names that plan. Given: two plans each with 4 backup files while retention is 5 (8 total across both). When: doctor runs. Then: plan.backups is "ok" (no single plan exceeds retention). Given: no plans/ directory. When: doctor runs. Then: plan.none is "ok".</criteria>
  </acceptance>
  <depends>FR-PLAN-0017, FR-PLAN-0024</depends>
  <implementationNotes>src/rosettify/src/commands/doctor/detectors.ts</implementationNotes>
</req>

## FR-DOC-0005 Hook Registration Presence

<req id="FR-DOC-0005" type="FR" level="System">
  <title>Check that a detected install's referenced hook bundle exists on disk</title>
  <statement>For each IDE where FR-DOC-0002 detects an install, doctor SHALL check whether that install's `hooks.json` (or, for Codex, `.codex-plugin/hooks.json`) is present and, when present, whether every `.js` bundle path it references resolves to an existing file. A referenced bundle path SHALL be recognized whether or not it is wrapped in quotes in the hooks.json command string (real installs emit both forms — cursor/codex/antigravity commands are typically unquoted, e.g. `node ${CLAUDE_PLUGIN_DIR}/skills/harness/scripts/tester.js --output '...'`). A `${CLAUDE_PLUGIN_DIR}`-style macro in the path SHALL resolve to the install directory; a path carrying no such macro SHALL resolve relative to `root` (the workspace root doctor was invoked against), NOT relative to the install directory — copilot's own hooks.json commands carry no plugin-dir macro and are already written relative to the workspace root (e.g. `.github/hooks/x.js`), so resolving them against the install directory a second time would double up the install directory's own name in the resolved path and report an existing bundle as missing. This SHALL be reported as `hooks.<ide>` at status "ok" when the hooks file is present and every referenced bundle resolves, "warn" when the install has no hooks file at all (deterministic hooks are opt-in — ARCHITECTURE.md — so this is expected for most installs), and "fail" when a hooks file is present but references a bundle path that does not resolve to an existing file (a broken install). doctor SHALL NOT execute any referenced bundle.</statement>
  <rationale>A hooks.json that references a missing bundle is exactly the "hook registered but its file was never synced" failure mode F2-9 names, and it is silent at runtime — the IDE simply never fires that hook, with no error anywhere a human would see. Read-only static resolution (never executing the bundle) keeps this check within doctor's zero-side-effect posture. Matching both quoted and unquoted command forms matters because a real generated hooks.json is predominantly unquoted (see plugins/core-cursor-standalone/.cursor/skills/harness/references/hooks/*/hooks.json for the actual shape) — a quote-only matcher silently never reported a missing bundle referenced this way, which is worse than not checking at all because it looks like a passing check. Resolving a macro-free path against the workspace root rather than the install directory matches how copilot's own hooks.json is actually written and avoids a false "fail" on every genuinely-present bundle it references.</rationale>
  <source>User</source>
  <ticketId>CTORNDGAIN-1333</ticketId>
  <priority>Should</priority>
  <status>Draft</status>
  <approved_by></approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: a detected Cursor install with no .cursor/hooks.json. When: doctor runs. Then: hooks.cursor is "warn". Given: a detected install whose hooks.json references a bundle file that is present (quoted, macro-based path). When: doctor runs. Then: hooks.<ide> is "ok". Given: a detected install whose hooks.json references a bundle file that is absent. When: doctor runs. Then: hooks.<ide> is "fail". Given: a detected install whose hooks.json command references an existing bundle via an unquoted, macro-based path (e.g. `node ${CLAUDE_PLUGIN_DIR}/skills/harness/scripts/tester.js --tag x`). When: doctor runs. Then: hooks.<ide> is "ok" (the bundle is found despite being unquoted). Given: a detected Copilot install whose hooks.json command references an existing bundle via a macro-free, workspace-root-relative quoted path (e.g. `.github/hooks/x.js`). When: doctor runs. Then: hooks.<ide> is "ok" (resolved against the workspace root, not doubled against the install directory).</criteria>
  </acceptance>
  <depends>FR-DOC-0002</depends>
  <implementationNotes>src/rosettify/src/commands/doctor/detectors.ts</implementationNotes>
</req>

## FR-DOC-0006 Compliance Mode

<req id="FR-DOC-0006" type="FR" level="System">
  <title>--compliance adds file checksums and a machine-readable summary</title>
  <statement>When `compliance` is true, doctor SHALL, for every IDE install FR-DOC-0002 detected, compute a SHA-256 checksum of every Rosetta-owned file under that install's directory (bounded to the first 5000 candidate files per install; a bound reached SHALL be reported in that install's `truncated` flag) and add to the result a `compliance` field of the named type `DoctorComplianceReport` = { generated_at (ISO8601 UTC), installs: DoctorComplianceInstall[] }, where `DoctorComplianceInstall` = { ide, version, root, file_count, truncated, combined_hash, skipped_large_files, unreadable_files }. A file is Rosetta-owned when it sits directly under one of the subdirectory names the standalone install layouts actually ship (`agents`, `commands`, `configure`, `hooks`, `instructions`, `prompts`, `rules`, `skills` — see PLUGINS.md) or is the recognized top-level `hooks.json`; a user's own file that happens to sit alongside the install (e.g. a target repository's own `.github/workflows/*.yml`) SHALL NOT be hashed or counted. Each owned file over a per-file size cap SHALL be skipped (not hashed) and its relative path recorded in `skipped_large_files` rather than being read; each owned file that cannot be read (permission error, broken symlink, or any other read failure) SHALL be recorded in `unreadable_files` rather than failing the scan. `combined_hash` SHALL be the SHA-256 of the newline-joined, path-sorted list of `"<relative-path> <sha256>"` entries for every successfully hashed file, so two installs are byte-for-byte identical if and only if their `combined_hash` values match (a skipped or unreadable file is excluded from this list on both sides, so it does not by itself break an otherwise-identical comparison). `compliance` SHALL be omitted from the result when `compliance` is false (the default). This mode SHALL remain read-only and make no network call, and SHALL NOT return an `internal_error` merely because one file among many could not be hashed.</statement>
  <rationale>A single combined hash per install lets an MDM or CI compliance job compare a fleet install against a known-good release checksum (F3-9's fleet-verification use case) in one field, without shipping every individual file hash back to the caller by default; the full per-file basis is still reconstructable locally because the algorithm is fully specified. Restricting hashing to Rosetta-owned files keeps the fleet comparison meaningful: a user's own files sitting alongside the install (CI workflows, editor settings) vary per repository for reasons that have nothing to do with whether the Rosetta install itself is intact, and hashing them would make `combined_hash` diverge across a perfectly healthy fleet. Recording (rather than failing on) an oversize or unreadable file matches doctor's read-only diagnostic posture — one unreadable file under an install directory is itself useful compliance signal, and should not deny the caller every other file's result. Bounding file count keeps a very large install from making doctor itself slow, consistent with doctor's read-only, bounded-scan posture (mirrors FR-SPECS-0027).</rationale>
  <source>User</source>
  <ticketId>CTORNDGAIN-1333</ticketId>
  <priority>Should</priority>
  <status>Draft</status>
  <approved_by></approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: doctor run with compliance:false. When: executed. Then: result carries no compliance field. Given: doctor run with compliance:true against a root with one detected install of 3 Rosetta-owned files. When: executed. Then: result.compliance.installs has one entry with file_count 3 and a combined_hash. Given: the same install scanned twice without any file changing. When: compliance runs both times. Then: combined_hash is identical across both runs. Given: an install directory carrying an unrelated user file (e.g. workflows/ci.yml) alongside its owned skills/ subdirectory. When: compliance runs. Then: file_count reflects only the owned files; the unrelated file is neither hashed nor counted. Given: one owned file over the per-file size cap. When: compliance runs. Then: that file's relative path appears in skipped_large_files and it is excluded from combined_hash, and the run still succeeds. Given: one owned file that cannot be read. When: compliance runs. Then: that file's relative path appears in unreadable_files, and the run still succeeds for every other file.</criteria>
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
  <status>Draft</status>
  <approved_by></approved_by>
  <changed>2026-09-27</changed>
  <verification>Test</verification>
  <acceptance>
    <criteria>Given: a root with a node_modules directory holding a file named plugin.json with name "rosetta". When: doctor runs. Then: that file is never inspected (excluded directory). Given: any doctor invocation. When: executed. Then: no new file or directory exists under root afterward that did not exist before.</criteria>
  </acceptance>
  <implementationNotes>src/rosettify/src/commands/doctor/detectors.ts, compliance.ts</implementationNotes>
</req>
