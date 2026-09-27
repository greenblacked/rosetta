---
name: delivery-flow
description: "Workflow to draft commit messages, PR descriptions traced to specs, a CHANGELOG entry, and release notes after work is approved; gated git/PR execution. Not for writing, reviewing, or testing code."
tags: ["workflow"]
baseSchema: docs/schemas/workflow.md
---

<delivery_flow>

<description_and_purpose>

Problem: engineers draft commit messages, PR descriptions, CHANGELOG entries, and release notes by hand after every approved change, disconnected from the plan/specs that justified it.
Solution: draft every delivery artifact from `plans/<FEATURE>/*`, `agents/IMPLEMENTATION.md`, and the diff via `change-communication`; get explicit HITL approval; execute only the exact approved git/PR actions under existing `dangerous-actions` guardrails.
Validation: every drafted claim traces to plan/specs/diff; no commit, push, tag, or PR is created without explicit approval of that exact action.

</description_and_purpose>

<workflow_phases>

<prerequisites phase="0" applies="ALL">

1. All Rosetta prep steps MUST be FULLY completed.
2. MUST USE SKILL `load-project-context` (required: all), `hitl` (all, unless `No HITL` or `Fully Autonomous`).
3. MUST ALWAYS use todo tasks ledger, ASAP. Phases are sequential.
4. Input is an already-approved change (own `coding-flow` output, an approved batch, or a tag range for release mode); if the change is not yet approved, stop and point to the owning workflow.
5. Workflow state MUST be saved to `agents/TEMP/<FEATURE>/delivery-flow-state.md`.

</prerequisites>

<draft phase="1" applies="ALL" subagent="engineer" role="Release engineer drafting traceable delivery artifacts" subagent_required_model="claude-sonnet-5, gpt-5.6-terra-medium, gemini-3.7-flash-low, grok-4.6">

1. USE SKILL `change-communication` to detect repo conventions (commit style, PR template, CHANGELOG format, branch naming) and draft commit message(s), PR description, CHANGELOG entry, and, if requested, release notes. Convention detection lives in the skill; do not re-detect it here.
2. Input: diff, `plans/<FEATURE>/*`, `agents/IMPLEMENTATION.md`, requirement IDs if in use. Output: drafts, each claim marked with its source.
3. Release mode (aggregate since last tag): gather merged features' `agents/IMPLEMENTATION.md` entries; group release notes by audience.
4. Required skills: `change-communication`. Recommended: `natural-writing`, `requirements-use`.
5. Update `delivery-flow-state.md`.

</draft>

<user_review_delivery phase="2" applies="ALL" type="HITL">

1. Present drafts with TLDR; separate sourced facts from any flagged gaps.
2. User MUST approve: "Yes, I approve the delivery drafts" — strict approval; anything else = feedback, iterate.
3. User separately names which actions to execute (commit, push, PR, CHANGELOG write, none).

</user_review_delivery>

<record phase="3" applies="if user approved a CHANGELOG or IMPLEMENTATION.md write" subagent="executor" role="Bounded delivery-record writer" subagent_required_model="claude-haiku-4-5, gpt-5.6-terra-low, gemini-3.7-flash-low, composer-2.5, gpt-5.6-luna" must-be-subagent>

1. Write the CHANGELOG entry, only if named in Phase 2, and update `agents/IMPLEMENTATION.md` with what shipped and its trace — before any commit, so both land in the change being committed and the tree is clean afterward.
2. Input: approved drafts. Output: written files, or a stop reason if not approved.
3. Update `delivery-flow-state.md`.

</record>

<execute phase="4" applies="if user approved any git/PR action" subagent="executor" role="Bounded delivery-action operator" subagent_required_model="claude-haiku-4-5, gpt-5.6-terra-low, gemini-3.7-flash-low, composer-2.5, gpt-5.6-luna" must-be-subagent>

1. USE SKILL `dangerous-actions` before any commit, push, PR creation, or tag; perform only the actions the user explicitly named in Phase 2, including the Phase 3 file writes already on disk.
2. Input: approved drafts, approved action list, Phase 3 file writes. Output: executed actions and their results, or a stop reason.
3. Local commit without push still requires the Phase 2 approval that named it.
4. Never widen scope beyond the named actions; never retry a declined action.
5. Mark `delivery-flow-state.md` complete.

</execute>

</workflow_phases>

<references>

- Skill `change-communication` — drafting guidance and templates
- Skill `dangerous-actions` — guardrail for push/PR/tag actions (referenced, not restated)
- Skill `hitl` — approval mechanics (referenced, not restated)

</references>

<validation_checklist>

- Every draft claim traces to plan, specs, diff, or requirement ID
- No push, PR, tag, or CHANGELOG write without the exact Phase 2 approval naming it
- Detected repo conventions used over generic defaults

</validation_checklist>

<pitfalls>

- Treating Phase 2 approval of drafts as approval to execute
- Drafting a PR description with claims not present in the diff
- Naming a specific git/PR tool instead of describing the action generically

</pitfalls>

</delivery_flow>
