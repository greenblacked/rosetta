"""Regression checks for publish-instructions.yml's checksum + attestation steps
(F3-1 MVP: SHA256SUMS + actions/attest-build-provenance on release assets).

Run: python3 -m pytest .github/scripts/test_publish_instructions_workflow.py
"""
from pathlib import Path

import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "publish-instructions.yml"


def _load_workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _steps() -> list[dict]:
    return _load_workflow()["jobs"]["publish"]["steps"]


def _step_named(name: str) -> dict:
    for step in _steps():
        if step.get("name") == name:
            return step
    raise AssertionError(f"step {name!r} not found in publish-instructions.yml")


def test_workflow_level_permissions_are_read_only():
    workflow = _load_workflow()
    assert workflow["permissions"] == {"contents": "read"}


def test_publish_job_grants_only_what_it_needs():
    job = _load_workflow()["jobs"]["publish"]
    assert job["permissions"] == {
        "contents": "write",
        "id-token": "write",
        "attestations": "write",
    }


def test_checksums_are_generated_over_instructions_and_plugin_zips():
    step = _step_named("Generate checksums")
    assert "sha256sum instructions.zip" in step["run"]
    assert "${{ steps.plugins.outputs.archives }}" in step["run"]
    assert "SHA256SUMS" in step["run"]


def test_checksums_are_uploaded_to_the_release():
    step = _step_named("Upload checksums to the release")
    assert "gh release upload" in step["run"]
    assert "SHA256SUMS" in step["run"]


def test_checksum_steps_only_run_when_a_release_is_created():
    condition = "${{ github.event_name == 'push' || inputs.create_release }}"
    assert _step_named("Generate checksums")["if"] == condition
    assert _step_named("Upload checksums to the release")["if"] == condition


def test_attestation_step_covers_release_assets_and_never_breaks_publishing():
    step = _step_named("Attest build provenance")
    assert step["uses"].startswith("actions/attest-build-provenance@")
    assert step["continue-on-error"] is True
    assert step["with"]["subject-path"] == "*.zip"


def test_no_event_context_is_interpolated_into_run_blocks():
    for step in _steps():
        run = step.get("run")
        if run:
            assert "github.event." not in run, f"unsafe interpolation: {run!r}"


def test_summary_documents_the_verify_commands():
    step = _step_named("Summary")
    assert "sha256sum -c SHA256SUMS" in step["run"]
    assert "gh attestation verify" in step["run"]
