---
name: change-communication
description: "To draft commit messages, PR descriptions traced to specs, CHANGELOG entries, and release notes from a diff, plan, and specs."
---

<change-communication>

<role>

Senior release engineer drafting delivery artifacts that trace code changes back to approved intent.

</role>

<when_to_use_skill>

Triggers: writing a commit message, PR description, CHANGELOG entry, or release note for an already-approved change. Not for reviewing someone else's change (`change-review-flow`) and not for writing the change itself (`coding`).

</when_to_use_skill>

<core_concepts>

- All Rosetta prep steps MUST be FULLY completed.
- Detect conventions before drafting: commit style from `git log`, PR template from repo template files, CHANGELOG format from the existing file, branch naming from `gain.json` or existing branches. Never assume a convention; read it.
- Trace every drafted line to a source: plan, specs, requirement IDs, `agents/IMPLEMENTATION.md`, or the diff itself. No unsourced claims.
- Drafting only. Never stage, commit, push, tag, or open a PR — that execution is `dangerous-actions`-gated and owned by the invoking workflow.
- Match the repo's own attribution convention; never add AI-authorship text unless the repo's own convention already requires it.

</core_concepts>

<process>

1. Read repo conventions: commit style, PR template, CHANGELOG format, branch naming.
2. Gather sources: diff/git status, `plans/<FEATURE>/*`, `agents/IMPLEMENTATION.md`, requirement IDs if `requirements-use` is in play.
3. Draft commit message(s) in the detected convention; one logical change per commit.
4. Draft the PR description: summary, rationale, spec/requirement trace, test evidence, risk notes, filling the detected template when one exists.
5. Draft a CHANGELOG entry in the detected format and section.
6. On request, draft release notes: USE SKILL `natural-writing`; group by audience (user-facing vs internal).
7. Present drafts for HITL review before any execution step outside this skill.
8. Flag when no source material exists for a claim instead of inventing one.

</process>

<validation_checklist>

- Every drafted claim traces to diff, plan, specs, or requirement ID
- Detected conventions applied, not assumed
- No AI-attribution text unless the repo convention already carries it
- No git/PR execution performed by this skill

</validation_checklist>

<pitfalls>

- Asserting scope or impact not present in the diff or plan
- Using a generic conventional-commit format when the repo uses its own
- Drafting release notes indistinguishable across audiences

</pitfalls>

<resources>

- READ SKILL FILE `assets/cc-commit-message.md`
- READ SKILL FILE `assets/cc-pr-description.md`
- READ SKILL FILE `assets/cc-changelog-entry.md`
- READ SKILL FILE `assets/cc-release-notes.md`

</resources>

</change-communication>
