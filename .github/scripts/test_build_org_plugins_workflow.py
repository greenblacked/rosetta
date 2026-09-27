"""Regression checks for build-org-plugins.yml (F3-8 MVP: org-overlay plugin build).

Run: python3 -m pytest .github/scripts/test_build_org_plugins_workflow.py
"""
import re
from pathlib import Path

import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "build-org-plugins.yml"


def _load_workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _on_section(workflow: dict) -> dict:
    # PyYAML (YAML 1.1) parses the bare `on:` key as the boolean True, not the string "on";
    # every helper below reads it through this accessor instead of indexing "on" directly.
    return workflow.get("on", workflow.get(True))


def _steps() -> list[dict]:
    return _load_workflow()["jobs"]["build"]["steps"]


def _step_named(name: str) -> dict:
    for step in _steps():
        if step.get("name") == name:
            return step
    raise AssertionError(f"step {name!r} not found in build-org-plugins.yml")


def test_workflow_exists_and_parses():
    assert WORKFLOW_PATH.is_file()
    workflow = _load_workflow()
    assert "jobs" in workflow
    assert "build" in workflow["jobs"]


def test_triggered_only_by_workflow_dispatch():
    workflow = _load_workflow()
    on = _on_section(workflow)
    assert isinstance(on, dict), f"unexpected 'on' shape: {on!r}"
    assert set(on.keys()) == {"workflow_dispatch"}, f"workflow must be workflow_dispatch-only, got triggers: {sorted(on.keys())}"


def test_org_domain_input_is_required_and_has_no_default():
    workflow = _load_workflow()
    on = _on_section(workflow)
    org_domain = on["workflow_dispatch"]["inputs"]["org_domain"]
    assert org_domain["required"] is True
    assert "default" not in org_domain


def test_release_input_defaults_to_r3():
    workflow = _load_workflow()
    on = _on_section(workflow)
    release = on["workflow_dispatch"]["inputs"]["release"]
    assert release["default"] == "r3"


def test_workflow_level_permissions_are_read_only():
    workflow = _load_workflow()
    assert workflow["permissions"] == {"contents": "read"}


def test_build_job_grants_only_read_contents():
    job = _load_workflow()["jobs"]["build"]
    assert job["permissions"] == {"contents": "read"}


def test_no_github_event_context_is_interpolated_into_run_blocks():
    for step in _steps():
        run = step.get("run")
        if run:
            assert "github.event." not in run, f"unsafe interpolation in step {step.get('name')!r}: {run!r}"


def test_no_expression_interpolation_at_all_in_run_blocks():
    # Stronger than the github.event.* check above: every run: block in this workflow should use
    # plain shell env vars (sourced from a validated GITHUB_ENV write), never any `${{ ... }}`
    # expression, so validated/sanitized input never re-enters a later run block unsanitized.
    for step in _steps():
        run = step.get("run")
        if run:
            assert "${{" not in run, f"unexpected expression interpolation in step {step.get('name')!r}: {run!r}"


def test_inputs_are_only_read_via_env_blocks_not_inline_in_run():
    validate_step = _step_named("Validate and resolve build inputs")
    env = validate_step.get("env", {})
    assert env.get("ORG_DOMAIN_INPUT") == "${{ inputs.org_domain }}"
    assert env.get("RELEASE_INPUT") == "${{ inputs.release }}"
    assert env.get("PROFILE_INPUT") == "${{ inputs.profile }}"
    assert env.get("DETERMINISTIC_HOOKS_INPUT") == "${{ inputs.deterministic_hooks }}"


def test_validate_step_rejects_domain_names_containing_core():
    validate_step = _step_named("Validate and resolve build inputs")
    run = validate_step["run"]
    assert 'ORG_DOMAIN_INPUT} == *"core"*' in run.replace("\\", "") or "*\"core\"*" in run
    assert "must not include" in run


def test_validate_step_writes_domain_release_profile_to_github_env():
    validate_step = _step_named("Validate and resolve build inputs")
    run = validate_step["run"]
    assert 'echo "domain=core,${ORG_DOMAIN_INPUT}"' in run
    assert 'echo "release=${release}"' in run
    assert 'echo "profile=${profile}"' in run
    assert 'GITHUB_ENV' in run


def test_build_step_invokes_local_generator_with_domain_and_output():
    build_step = _step_named("Build org plugin set")
    run = build_step["run"]
    assert "src/rosettify-plugins/dist/cli.js" in run
    assert "--domain" in run
    assert "--output" in run
    assert "--release" in run
    assert "--deterministic-hooks" in run
    # Profile is conditionally appended, never a hardcoded flag with an empty value.
    assert "if [[ -n \"${profile}\" ]]" in run


def test_dependencies_are_installed_with_npm_ci_before_build():
    install_step = _step_named("Install rosettify-plugins dependencies")
    assert install_step["run"].strip() == "npm ci"
    assert install_step["working-directory"] == "src/rosettify-plugins"


def test_upload_artifact_step_is_least_privilege_and_never_empty():
    upload_step = _step_named("Upload org plugin set artifact")
    assert upload_step["uses"].startswith("actions/upload-artifact@")
    assert upload_step["with"]["if-no-files-found"] == "error"
    assert upload_step["with"]["path"] == "${{ runner.temp }}/org-plugins-out"


def test_concurrency_group_is_scoped_per_ref():
    workflow = _load_workflow()
    concurrency = workflow["concurrency"]
    assert concurrency["group"] == "build-org-plugins-${{ github.ref }}"
    assert concurrency["cancel-in-progress"] is True


def test_action_versions_are_pinned_to_a_tag():
    for step in _steps():
        uses = step.get("uses")
        if uses:
            assert re.match(r"^[^@]+@v\d", uses), f"unpinned action: {uses!r}"
