"""Regression checks for validate-prompts.yml (C5, C6, R3, F5, F6).

C5: the concurrency group must not collapse every PR into one group under
pull_request_target (github.ref is always the base branch there).
C6: workflow_dispatch runs must resolve a real checkout directory and must
not hide a git failure behind `2>/dev/null || true`.
R3: workflow_dispatch runs must check out the dispatched ref (not a
hard-coded `main`), and must diff against origin/main instead of HEAD^ when
there is no PR base ref, so dispatching a non-main branch actually audits
that branch instead of silently auditing main.
F5: the agent prompts (Claude and Codex) must pass the real
steps.changed-files.outputs.pr_dir instead of a hard-coded `pr`, which does
not exist on workflow_dispatch runs (content is checked out at `.` there).
The Codex branch must carry it through `env:`, not by interpolating
`${{ }}` directly into the `run:` script.
F6: dispatching main itself must not diff origin/main...HEAD (always empty,
since HEAD IS origin/main there) -- it must fall back to HEAD^ instead. A
dispatch run that ends up with 0 changed files must emit a visible
`::notice::` explaining nothing was validated.
"""

from pathlib import Path

import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "validate-prompts.yml"


def _load_workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _changed_files_run_script() -> str:
    workflow = _load_workflow()
    steps = workflow["jobs"]["validate"]["steps"]
    for step in steps:
        if step.get("id") == "changed-files":
            return step["run"]
    raise AssertionError("'changed-files' step not found in validate-prompts.yml")


def _first_checkout_step() -> dict:
    workflow = _load_workflow()
    steps = workflow["jobs"]["validate"]["steps"]
    for step in steps:
        if step.get("name") == "Checkout repository":
            return step
    raise AssertionError("'Checkout repository' step not found in validate-prompts.yml")


def _generate_diff_run_script() -> str:
    workflow = _load_workflow()
    steps = workflow["jobs"]["validate"]["steps"]
    for step in steps:
        if step.get("name") == "Generate diff":
            return step["run"]
    raise AssertionError("'Generate diff' step not found in validate-prompts.yml")


def _claude_validation_step() -> dict:
    workflow = _load_workflow()
    steps = workflow["jobs"]["validate"]["steps"]
    for step in steps:
        if step.get("id") == "run-validation":
            return step
    raise AssertionError("'run-validation' step not found in validate-prompts.yml")


def _assemble_codex_prompt_step() -> dict:
    workflow = _load_workflow()
    steps = workflow["jobs"]["validate"]["steps"]
    for step in steps:
        if step.get("name") == "Assemble Codex prompt":
            return step
    raise AssertionError("'Assemble Codex prompt' step not found in validate-prompts.yml")


def test_concurrency_group_is_keyed_on_pr_number_with_ref_fallback() -> None:
    workflow = _load_workflow()
    concurrency = workflow["concurrency"]

    assert concurrency["group"] == (
        "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}"
    )
    # Regression guard: the old, PR-number-less group collapsed every PR
    # under pull_request_target into one group and cancelled in-flight runs.
    assert concurrency["group"] != "${{ github.workflow }}-${{ github.ref }}"
    assert concurrency["cancel-in-progress"] is True


def test_changed_files_step_resolves_a_real_checkout_dir_for_dispatch() -> None:
    script = _changed_files_run_script()

    # Must branch on the event name rather than hard-coding "pr" (which only
    # exists on pull_request_target; workflow_dispatch has no pr/ checkout).
    assert 'GITHUB_EVENT_NAME" = "pull_request_target"' in script
    assert 'PR_DIR="pr"' in script
    assert 'PR_DIR="."' in script
    assert 'git -C "$PR_DIR"' in script
    # The old unconditional `git -C pr ...` must be gone.
    assert "git -C pr " not in script


def test_changed_files_step_does_not_swallow_git_failures() -> None:
    script = _changed_files_run_script()

    assert "diff --name-only" in script
    # The diff command that feeds CHANGED_FILES must not hide a git failure
    # behind `2>/dev/null || true` -- that turned a real error into a false
    # "0 files changed" green run.
    diff_line = next(
        line for line in script.splitlines() if "git -C" in line and "diff --name-only" in line
    )
    assert "2>/dev/null" not in diff_line
    assert "|| true" not in diff_line


def test_generate_diff_step_uses_the_resolved_pr_dir_and_does_not_swallow_errors() -> None:
    script = _generate_diff_run_script()

    assert 'git -C "$PR_DIR"' in script
    assert "git -C pr " not in script
    diff_line = next(line for line in script.splitlines() if line.strip().startswith("git -C"))
    assert "2>/dev/null" not in diff_line
    assert "|| true" not in diff_line


def test_first_checkout_uses_dispatched_ref_for_workflow_dispatch() -> None:
    """R3 regression: dispatching branch X must check out X, not main.

    The old hard-coded `ref: main` meant PR_DIR="." (used for
    workflow_dispatch) always pointed at main's checkout regardless of which
    ref was dispatched, so the changed-files diff silently audited main.
    """
    step = _first_checkout_step()
    ref_expr = step["with"]["ref"]

    assert ref_expr == (
        "${{ github.event_name == 'workflow_dispatch' && github.ref || 'main' }}"
    )
    # Regression guard: the old unconditional value must be gone.
    assert ref_expr != "main"
    # pull_request_target must still resolve to main -- the base repo's code,
    # never the fork's -- which is what makes the local actions/scripts that
    # run afterwards (Set up Codex, etc.) trusted.
    assert "'main'" in ref_expr
    assert "workflow_dispatch" in ref_expr
    assert "github.ref" in ref_expr


def test_changed_files_step_diffs_dispatch_runs_against_origin_main() -> None:
    """R3 regression: a dispatch with no PR base ref must not fall back to
    HEAD^, which only ever sees the last commit relative to the dispatched
    ref (wrong for a long-lived feature branch, and a no-op if main IS the
    dispatched ref). It must fetch and diff against origin/main instead.
    """
    script = _changed_files_run_script()

    assert 'GITHUB_EVENT_NAME" = "workflow_dispatch"' in script
    assert "git -C \"$PR_DIR\" fetch origin main" in script
    assert 'BASE_REF="origin/main"' in script

    # HEAD^ must remain only as the final fallback (e.g. push events), not
    # the one used for workflow_dispatch.
    lines = script.splitlines()
    workflow_dispatch_branch_idx = next(
        i for i, line in enumerate(lines) if 'GITHUB_EVENT_NAME" = "workflow_dispatch"' in line
    )
    head_caret_idx = next(i for i, line in enumerate(lines) if 'BASE_REF="HEAD^"' in line)
    assert workflow_dispatch_branch_idx < head_caret_idx


def test_claude_prompt_uses_the_resolved_pr_dir_not_hardcoded_pr() -> None:
    """F5 regression: the Claude branch's `PR content path:` line must carry

    the real steps.changed-files.outputs.pr_dir. On workflow_dispatch that
    output resolves to `.`, not `pr` -- a hard-coded `pr` points the agent's
    `git -C pr show ...` commands at a directory that does not exist there.
    """
    step = _claude_validation_step()
    prompt = step["with"]["prompt"]

    assert "PR content path: ${{ steps.changed-files.outputs.pr_dir }}" in prompt
    # Regression guard: the old hard-coded value must be gone.
    assert "PR content path: pr\n" not in prompt
    assert not any(
        line.strip() == "PR content path: pr" for line in prompt.splitlines()
    )


def test_codex_prompt_assembly_passes_pr_dir_via_env_not_inline_interpolation() -> None:
    """F5 regression: the Codex branch must not hard-code `pr` either, and

    must carry pr_dir through `env:` rather than interpolating `${{ }}`
    directly into the `run:` script (script-injection safety).
    """
    step = _assemble_codex_prompt_step()
    env = step.get("env", {})
    script = step["run"]

    assert env.get("PR_DIR") == "${{ steps.changed-files.outputs.pr_dir }}"
    assert 'printf \'PR content path: %s\\n\' "$PR_DIR"' in script
    # Regression guard: the old hard-coded value must be gone.
    assert "PR content path: pr" not in script
    # No `${{ }}` expression may appear directly inside the run: script --
    # every dynamic value must be threaded through `env:` first.
    assert "${{" not in script


def test_dispatch_on_main_falls_back_to_head_caret() -> None:
    """F6 regression: dispatching `main` itself must not diff

    origin/main...HEAD, which is always empty there (HEAD IS origin/main),
    silently validating nothing. It must use HEAD^ instead in that case.
    """
    script = _changed_files_run_script()

    assert 'GITHUB_REF" = "refs/heads/main"' in script
    lines = script.splitlines()
    workflow_dispatch_idx = next(
        i for i, line in enumerate(lines) if 'GITHUB_EVENT_NAME" = "workflow_dispatch"' in line
    )
    main_check_idx = next(
        i for i, line in enumerate(lines) if 'GITHUB_REF" = "refs/heads/main"' in line
    )
    origin_main_idx = next(
        i for i, line in enumerate(lines) if 'BASE_REF="origin/main"' in line
    )
    # The main-vs-not-main check must live inside the workflow_dispatch
    # branch, before origin/main is chosen as the (non-main) fallback.
    assert workflow_dispatch_idx < main_check_idx < origin_main_idx
    # No direct `${{ github.ref }}` interpolation in executable lines --
    # use the runner's default $GITHUB_REF env var instead (script-injection
    # safety). Comments referencing the expression in prose are fine.
    executable_lines = [line for line in lines if not line.strip().startswith("#")]
    assert not any("${{" in line for line in executable_lines)


def test_dispatch_with_zero_changed_files_emits_a_visible_notice() -> None:
    """F6 regression: a dispatch run that validates 0 files must say so

    loudly instead of looking identical to a healthy "no prompt changes" PR
    run.
    """
    script = _changed_files_run_script()

    lines = script.splitlines()
    zero_count_idx = next(
        i for i, line in enumerate(lines) if 'count=0' in line and "GITHUB_OUTPUT" in line
    )
    notice_idx = next(
        i for i, line in enumerate(lines) if "::notice::" in line and "nothing was validated" in line
    )
    dispatch_check_idx = next(
        i
        for i, line in enumerate(lines)
        if 'GITHUB_EVENT_NAME" = "workflow_dispatch"' in line and i > zero_count_idx
    )
    assert zero_count_idx < dispatch_check_idx < notice_idx
