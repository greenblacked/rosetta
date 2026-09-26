"""Regression checks for validate-prompts.yml (C5, C6).

C5: the concurrency group must not collapse every PR into one group under
pull_request_target (github.ref is always the base branch there).
C6: workflow_dispatch runs must resolve a real checkout directory and must
not hide a git failure behind `2>/dev/null || true`.
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


def _generate_diff_run_script() -> str:
    workflow = _load_workflow()
    steps = workflow["jobs"]["validate"]["steps"]
    for step in steps:
        if step.get("name") == "Generate diff":
            return step["run"]
    raise AssertionError("'Generate diff' step not found in validate-prompts.yml")


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
