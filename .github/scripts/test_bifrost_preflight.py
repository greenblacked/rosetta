"""Regression checks for the Bifrost preflight gate in the agent-driven PR workflows.

Without the BIFROST_HOST_NAME / BIFROST_API_KEY secrets (forks, fresh repositories) the
agent jobs used to fail the PR check outright. A `preflight` job now tests for the
secrets and the agent job is skipped (a skipped job counts as passing) with a notice.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pytest
import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = {
    "validate-prompts.yml": "validate",
    "repo-triage.yml": "triage",
}


def _load(name: str) -> dict:
    return yaml.safe_load((REPOSITORY_ROOT / ".github" / "workflows" / name).read_text())


def _check_step(workflow: dict) -> dict:
    steps = workflow["jobs"]["preflight"]["steps"]
    return next(step for step in steps if step.get("id") == "check")


@pytest.mark.parametrize("name,agent_job", WORKFLOWS.items())
def test_agent_job_is_gated_on_preflight(name: str, agent_job: str) -> None:
    jobs = _load(name)["jobs"]
    assert "preflight" in jobs
    assert jobs[agent_job]["needs"] == "preflight"
    assert jobs[agent_job]["if"] == "needs.preflight.outputs.bifrost == 'true'"


@pytest.mark.parametrize("name", WORKFLOWS)
def test_preflight_has_no_permissions_and_secrets_only_in_env(name: str) -> None:
    preflight = _load(name)["jobs"]["preflight"]
    assert preflight["permissions"] == {}
    step = _check_step(_load(name))
    assert step["env"] == {
        "BIFROST_HOST_NAME": "${{ secrets.BIFROST_HOST_NAME }}",
        "BIFROST_API_KEY": "${{ secrets.BIFROST_API_KEY }}",
    }
    assert "${{" not in step["run"], "no expression may be interpolated into the run script"


def test_triage_event_filter_moved_to_preflight() -> None:
    jobs = _load("repo-triage.yml")["jobs"]
    condition = jobs["preflight"]["if"]
    assert "'/rosetta'" in condition and "'[WIP]'" in condition


def test_validate_draft_filter_moved_to_preflight() -> None:
    jobs = _load("validate-prompts.yml")["jobs"]
    assert "draft != true" in jobs["preflight"]["if"]


@pytest.mark.parametrize("name", WORKFLOWS)
@pytest.mark.parametrize(
    "host,key,expected",
    [("gw.example", "k", "true"), ("", "k", "false"), ("gw.example", "", "false"), ("", "", "false")],
)
def test_preflight_script_output(name: str, host: str, key: str, expected: str) -> None:
    script = _check_step(_load(name))["run"]
    with tempfile.TemporaryDirectory() as tmp:
        output, summary = Path(tmp, "out"), Path(tmp, "summary")
        env = {
            "PATH": os.environ["PATH"],
            "BIFROST_HOST_NAME": host,
            "BIFROST_API_KEY": key,
            "GITHUB_OUTPUT": str(output),
            "GITHUB_STEP_SUMMARY": str(summary),
        }
        result = subprocess.run(["bash", "-e", "-c", script], env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        assert output.read_text().strip() == f"bifrost={expected}"
        if expected == "false":
            assert "::notice" in result.stdout
            assert "skipped" in summary.read_text()
        else:
            assert "::notice" not in result.stdout
