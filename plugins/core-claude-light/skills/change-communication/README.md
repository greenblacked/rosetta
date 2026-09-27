# change-communication

Drafts commit messages, PR descriptions, CHANGELOG entries, and release notes for an already-approved change, tracing every claim back to its source.

Detects repo conventions, drafts from diff/plan/specs, never executes git or PR actions itself.

## Why it exists

Without this skill a model drafting delivery text invents a commit style instead of reading the repo's own (`git log`, PR template, CHANGELOG format, branch naming), asserts scope or impact that is not actually in the diff or plan, and blurs user-facing release notes with internal ones. It would also be tempted to run the git/PR actions itself once the text looks good, collapsing drafting and execution into one ungated step. The skill forces convention detection before drafting, a source citation on every claim, and a hard boundary: this skill only drafts — committing, pushing, tagging, and opening a PR stay outside it, owned by the invoking workflow under `dangerous-actions`.

## When to engage

Actor: the `delivery-flow` workflow's `draft` phase (`USE SKILL change-communication`), for an already-approved change. Not for reviewing someone else's change (`change-review-flow`) and not for writing the change itself (`coding`). Prerequisite: All Rosetta prep steps fully completed.

## How it works

Single-file skill body (`SKILL.md`) plus four asset templates, no `references/`:

- `<role>` — senior release engineer drafting artifacts traced back to approved intent.
- `<core_concepts>` — detect-don't-assume conventions, trace every line to a source, drafting-only (no execution), match the repo's own attribution convention.
- `<process>` — eight steps: detect conventions (reusing the invoking workflow's summary if it already supplied one) → gather sources → draft commit message(s) → draft PR description → draft CHANGELOG entry → optionally draft release notes via `natural-writing` → return the drafts to the invoking workflow for its own HITL gate → flag missing source material instead of inventing it.
- `<validation_checklist>`, `<pitfalls>` — closing gates and named anti-patterns.
- `<resources>` — four asset files, one per artifact type.

## Mental hooks & unexpected rules

- `"Never assume a convention; read it."` (`core_concepts`) — commit style, PR template, CHANGELOG format, and branch naming are each read from the repo, not defaulted to a generic convention.
- `"Drafting only. Never stage, commit, push, tag, or open a PR"` (`core_concepts`) — the skill has no execution authority at all; that is `dangerous-actions`-gated and lives in the invoking workflow.
- `"Never add AI-authorship text unless the repo's own convention already requires it"` (`core_concepts`) — attribution follows the repo, not a default assumption either way.
- Step 7 returns drafts rather than performing HITL review itself — the invoking workflow (`delivery-flow` Phase 2) owns the approval gate via `hitl`; this skill is not the approval mechanism.
- `"Flag when no source material exists for a claim instead of inventing one"` (step 8) — an unsourced claim is a stop-and-flag, not a best-effort fill-in.

## Invariants — do not change

- `name: change-communication` must equal the folder name and the `docs/definitions/skills.md` entry `- change-communication`.
- `description` stays short and keyword-dense for auto-activation matching.
- `<core_concepts>`'s "drafting only" boundary and the "detect, never assume" convention rule are the skill's core value; loosening either changes behavior for every caller, not just prose.
- Step 1's convention detection is the single source of truth for repo conventions — `delivery-flow`'s draft phase invokes this skill for detection rather than re-inventorying conventions itself; do not reintroduce a duplicate detection step in the workflow.
- Step 7 returns drafts; it does not gate on HITL itself. The HITL gate belongs to the invoking workflow.
- Cross-skill reference to `natural-writing` (release notes step) uses bare skill-name form.
- `assets/cc-commit-message.md`, `assets/cc-pr-description.md`, `assets/cc-changelog-entry.md`, `assets/cc-release-notes.md` are referenced by exact path from `<resources>`; renaming any breaks that reference.

## Editing guide

Safe to extend: `<pitfalls>`, `<validation_checklist>`, and the asset templates — additive and low coupling risk.

Handle with care: `<core_concepts>` (drafting-only boundary, convention-detection-first rule, no-AI-attribution default) and the `<process>` step order — later steps (draft PR/CHANGELOG/release notes) assume conventions and sources were gathered first.

Referenced by: `instructions/r3/core/workflows/delivery-flow.md` (`USE SKILL change-communication` in its draft phase), `docs/definitions/skills.md` (registry entry).
