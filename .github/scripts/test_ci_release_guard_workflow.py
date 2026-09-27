"""Regression checks for ci-release-guard.yml (plugin-sync + dependency audit).

Run: python3 -m pytest .github/scripts/test_ci_release_guard_workflow.py
"""
from pathlib import Path

import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "ci-release-guard.yml"

EXPECTED_PATHS = {
    "instructions/**",
    "plugins/**",
    "src/rosettify-plugins/**",
    "src/hooks/**",
    "src/*/package.json",
    "src/*/package-lock.json",
    "requirements*.txt",
    "src/*/pyproject.toml",
    ".github/workflows/ci-release-guard.yml",
    ".github/scripts/npm_audit_gate.py",
}


def _load_workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _steps(job: dict) -> list[dict]:
    return job["steps"]


def _step_named(job: dict, name: str) -> dict:
    for step in _steps(job):
        if step.get("name") == name:
            return step
    raise AssertionError(f"step {name!r} not found in job")


def test_triggers_on_pull_request_and_push_to_main_with_path_filter():
    workflow = _load_workflow()
    triggers = workflow[True]  # yaml.safe_load parses bare `on:` key as boolean True

    assert set(triggers["pull_request"]["paths"]) == EXPECTED_PATHS
    assert triggers["push"]["branches"] == ["main"]
    assert set(triggers["push"]["paths"]) == EXPECTED_PATHS


def test_jobs_present():
    workflow = _load_workflow()
    assert set(workflow["jobs"]) == {"plugin-drift", "npm-audit", "pip-audit"}


def test_every_job_declares_least_privilege_read_only_permissions():
    workflow = _load_workflow()
    for job_name, job in workflow["jobs"].items():
        assert job.get("permissions") == {"contents": "read"}, (
            f"{job_name} must declare read-only permissions; this workflow "
            "never needs to write to the repository"
        )


def test_plugin_drift_builds_the_local_generator_not_npx():
    workflow = _load_workflow()
    job = workflow["jobs"]["plugin-drift"]
    run_scripts = " ".join(step.get("run", "") for step in _steps(job))

    assert "npx" not in run_scripts, "plugin-drift must use the locally built generator, not npx"
    assert "npm run build" in run_scripts
    assert "node src/rosettify-plugins/dist/cli.js" in run_scripts


def test_plugin_drift_regenerates_both_standard_and_lightweight_profiles():
    workflow = _load_workflow()
    job = workflow["jobs"]["plugin-drift"]
    run_scripts = [step.get("run", "") for step in _steps(job)]

    standard = "node src/rosettify-plugins/dist/cli.js --release r3 --deterministic-hooks false"
    lightweight = standard + " --profile lightweight"

    assert any(script.strip() == standard for script in run_scripts)
    assert any(lightweight in script for script in run_scripts)


def test_plugin_drift_diffs_only_the_plugins_directory():
    workflow = _load_workflow()
    job = workflow["jobs"]["plugin-drift"]
    check_step = _step_named(job, "Check plugins/ matches the regenerated output")
    assert "git diff --exit-code -- plugins/" in check_step["run"]
    assert "::error::" in check_step["run"]


def test_npm_audit_matrix_covers_every_npm_package_with_a_lockfile():
    workflow = _load_workflow()
    job = workflow["jobs"]["npm-audit"]
    packages = set(job["strategy"]["matrix"]["package"])

    expected = set()
    for lockfile in (REPOSITORY_ROOT / "src").glob("*/package-lock.json"):
        expected.add(f"src/{lockfile.parent.name}")

    assert packages == expected


def test_npm_audit_gate_fails_only_on_critical():
    workflow = _load_workflow()
    job = workflow["jobs"]["npm-audit"]
    gate_step = _step_named(job, "npm audit gate")
    assert "npm_audit_gate.py" in gate_step["run"]
    assert "--fail-at critical" in gate_step["run"]


def test_pip_audit_runs_against_root_requirements():
    workflow = _load_workflow()
    job = workflow["jobs"]["pip-audit"]
    run_scripts = " ".join(step.get("run", "") for step in _steps(job))
    assert "pip-audit -r requirements.txt" in run_scripts


def test_no_event_context_is_interpolated_into_run_blocks():
    """Security: nothing user-controlled (PR title/body/branch names, etc.) may be
    spliced into a `run:` shell block, only workflow-authored values."""
    workflow = _load_workflow()
    for job in workflow["jobs"].values():
        for step in _steps(job):
            run = step.get("run")
            if run:
                assert "github.event." not in run, f"unsafe interpolation: {run!r}"
