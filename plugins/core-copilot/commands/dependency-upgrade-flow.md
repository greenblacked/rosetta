---
name: dependency-upgrade-flow
description: "Workflow for batched dependency version bumps and CVE patches, ordered by dependency graph, with per-batch build/test validation and rollback. Not for language/framework rewrites or architecture change — use `modernization-flow` for those."
tags: ["workflow"]
baseSchema: docs/schemas/workflow.md
---

<dependency_upgrade_flow>

<description_and_purpose>

Problem: version bumps and CVE patches need migration research and safe, revertible batching; `modernization-flow`'s heavy analysis and 1-3 file batches do not fit routine dependency work.
Solution: inventory current versions, research breaking changes, plan dependency-graph-ordered batches, implement and validate one batch at a time with a rollback path, then update dependency docs.
Validation: each batch builds, tests, and re-scans clean before the next batch starts; a failed batch rolls back without touching later batches.

</description_and_purpose>

<workflow_phases>

<prerequisites phase="0" applies="ALL">

1. All Rosetta prep steps MUST be FULLY completed.
2. MUST USE SKILL `load-project-context` (required: all), `orchestration` (all except trivial), `hitl` (all, unless `No HITL` or `Fully Autonomous`), `risk-assessment` (registry/network access).
3. MUST ALWAYS use todo tasks ledger, ASAP. Phases 1-4 are sequential; each Phase 5-6 batch runs one at a time.
4. Read `docs/DEPENDENCIES.md` if present; if absent, Phase 1 builds a minimal inventory for the affected manifests only — do not run full `init-workspace-flow.md` for this.
5. Scope is version bumps and CVE patches with at most minimal call-site migration; a request needing rewrite, re-architecture, or language/framework change belongs in `modernization-flow.md` — stop and say so.
6. Workflow state MUST be saved to `agents/TEMP/<FEATURE>/dependency-upgrade-flow-state.md`.

</prerequisites>

<inventory phase="1" applies="ALL" subagent="executor" role="Bounded dependency inventory collector" subagent_required_model="Claude Haiku 4.5, GPT-5.6 Terra, Gemini 3.7 Flash, GPT-5.6 Luna">

1. Read `docs/DEPENDENCIES.md`, manifests, lockfiles, and any advisory/CVE input from the request.
2. Input: request, `docs/DEPENDENCIES.md`, manifests. Output: current-vs-target version table, per-module scope.
3. Update `dependency-upgrade-flow-state.md`.

</inventory>

<research phase="2" applies="ALL" subagent="researcher" role="Dependency migration researcher" subagent_required_model="GPT-5.6 Terra, Gemini 3.7 Flash">

1. Research release notes, breaking changes, migration guides, and transitive conflicts per target version.
2. Required skills: `research`. If a target is a private/internal library, hand off to `external-lib-flow.md` first.
3. Input: version table. Output: per-dependency migration notes and conflict list.
4. Update `dependency-upgrade-flow-state.md`.

</research>

<plan phase="3" applies="ALL" subagent="architect" role="Architect sequencing dependency batches by graph order" subagent_required_model="Claude Opus 5, GPT-5.6 Sol, Gemini 3.7 Flash">

1. Order updates by dependency graph; group into batches, each a bump plus minimal migration plus build plus test plus rollback note.
2. Required skills: `planning`, `tech-specs`. Recommended: `reasoning` for conflict tradeoffs.
3. Input: version table, migration notes, conflicts. Output: `plans/<FEATURE>/<FEATURE>-PLAN.md` batch sequence with rollback path per batch.
4. Update `dependency-upgrade-flow-state.md`.

</plan>

<user_review_plan phase="4" applies="ALL" type="HITL">

1. Present the batch sequence, migration risk, and rollback path per batch, with TLDR.
2. User MUST approve: "Yes, I approve the upgrade plan" — strict approval; anything else = feedback, iterate.

</user_review_plan>

<implement_batch phase="5" applies="ALL, once per approved batch" subagent="engineer" role="Engineer applying one approved dependency batch" subagent_required_model="Claude Sonnet 5, GPT-5.6 Terra, Gemini 3.7 Flash">

1. Bump the manifest/lockfile and apply only the migration this batch requires; no unrelated changes.
2. INVOKE SUBAGENT `executor` to build and run the affected tests.
3. Required skills: `coding`. Recommended: `dangerous-actions` (lockfile/registry access), `sensitive-data`.
4. On build/test failure: revert this batch only (USE SKILL `dangerous-actions` before any revert beyond uncommitted local changes); stop and report before the next batch.
5. Update `dependency-upgrade-flow-state.md`.

</implement_batch>

<validate_batch phase="6" applies="ALL, once per approved batch" subagent="validator" role="Batch validator re-scanning for the patched advisory" subagent_required_model="GPT-5.6 Terra, Gemini 3.7 Flash, Claude Sonnet 5">

1. Re-run the audit/CVE scan for this batch's dependencies; confirm the target advisory is resolved.
2. Input: batch diff, build/test result. Output: clean, still-vulnerable, or error, with evidence.
3. Still-vulnerable or error → stop this batch, return to Phase 5 or escalate via `hitl`; never advance to the next batch on an unresolved advisory.
4. Update `dependency-upgrade-flow-state.md`.

</validate_batch>

<record phase="7" applies="ALL">

1. Update `docs/DEPENDENCIES.md` and `docs/TECHSTACK.md` with the new versions.
2. Offer handoff to `delivery-flow.md` for commit/PR/CHANGELOG drafting; do not invoke it.
3. Mark `dependency-upgrade-flow-state.md` complete.

</record>

</workflow_phases>

<references>

- Workflow `modernization-flow.md` — rewrites, re-architecture, language/framework change (out of this flow's scope)
- Workflow `external-lib-flow.md` — onboarding a private/internal library before researching its migration
- Workflow `delivery-flow.md` — commit/PR/CHANGELOG drafting after upgrade completion
- Skill `dangerous-actions` — guardrail for registry/lockfile/revert actions (referenced, not restated)

</references>

<validation_checklist>

- Every batch builds, tests, and re-scans clean before the next batch starts
- Rollback path recorded and exercised on any batch failure
- `docs/DEPENDENCIES.md`/`docs/TECHSTACK.md` reflect the final versions

</validation_checklist>

<pitfalls>

- Bundling unrelated code changes into a version-bump batch
- Advancing to the next batch with an unresolved advisory
- Treating this flow as a substitute for `modernization-flow` on a framework rewrite

</pitfalls>

</dependency_upgrade_flow>
