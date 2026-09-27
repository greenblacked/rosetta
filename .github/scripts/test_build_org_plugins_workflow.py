"""Regression checks for build-org-plugins.yml (F3-8 MVP: org-overlay plugin build).

Run: python3 -m pytest .github/scripts/test_build_org_plugins_workflow.py
"""
import os
import re
import subprocess
import textwrap
from pathlib import Path

import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "build-org-plugins.yml"
CI_RELEASE_GUARD_PATH = REPOSITORY_ROOT / ".github" / "workflows" / "ci-release-guard.yml"
THIS_TEST_FILE_RELATIVE = ".github/scripts/test_build_org_plugins_workflow.py"


def _load_workflow() -> dict:
    return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))


def _load_ci_release_guard_workflow() -> dict:
    return yaml.safe_load(CI_RELEASE_GUARD_PATH.read_text(encoding="utf-8"))


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


def test_validate_step_rejects_core_as_an_exact_domain_entry_only():
    # A substring check (`== *"core"*`) would also wrongly reject "score" or "hardcore"; the
    # workflow must instead split on "," and compare each entry for an exact match.
    validate_step = _step_named("Validate and resolve build inputs")
    run = validate_step["run"]
    assert '== *"core"*' not in run
    assert "must not include" in run
    assert 'IFS=\',\'' in run or "IFS=','" in run

    _assert_core_domain_check_behavior(run)


def _assert_core_domain_check_behavior(validate_run: str) -> None:
    # Exercises the exact bash snippet the workflow uses to reject/accept org_domain, so this test
    # fails if the logic regresses even if the surrounding script text changes shape.
    script = textwrap.dedent(
        """
        set -euo pipefail
        ORG_DOMAIN_INPUT="$1"
        IFS=',' read -ra org_domain_entries <<< "${ORG_DOMAIN_INPUT}"
        for org_domain_entry in "${org_domain_entries[@]}"; do
          if [[ "${org_domain_entry}" == "core" ]]; then
            echo "REJECTED"
            exit 1
          fi
        done
        echo "ACCEPTED"
        """
    )
    assert "IFS=',' read -ra org_domain_entries" in validate_run, (
        "workflow's own domain-splitting snippet changed shape; update this test's mirrored script"
    )

    for domain, expected in [
        ("core", "REJECTED"),
        ("acme,core", "REJECTED"),
        ("core,acme", "REJECTED"),
        ("score", "ACCEPTED"),
        ("hardcore", "ACCEPTED"),
        ("acme,acme-eu", "ACCEPTED"),
    ]:
        result = subprocess.run(
            ["bash", "-c", script, "bash", domain],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.stdout.strip() == expected, (
            f"org_domain={domain!r}: expected {expected}, got {result.stdout!r} / {result.stderr!r}"
        )


def test_error_annotations_never_echo_raw_input_values():
    # Untrusted workflow_dispatch string inputs may contain newlines; echoing one back inside an
    # ::error:: annotation lets a newline inject an unrelated workflow command. Every ::error::
    # line must therefore be fixed text, never interpolate the raw *_INPUT env vars or the derived
    # `release`/`profile`/`domain` shell vars.
    validate_step = _step_named("Validate and resolve build inputs")
    run = validate_step["run"]
    for line in run.splitlines():
        if "::error::" not in line:
            continue
        assert "${ORG_DOMAIN_INPUT}" not in line, f"raw input echoed in error line: {line!r}"
        assert "${RELEASE_INPUT}" not in line, f"raw input echoed in error line: {line!r}"
        assert "${PROFILE_INPUT}" not in line, f"raw input echoed in error line: {line!r}"
        assert "${release}" not in line, f"raw input echoed in error line: {line!r}"
        assert "${profile}" not in line, f"raw input echoed in error line: {line!r}"
        assert "got:" not in line, f"raw input echoed in error line: {line!r}"


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


def test_hooks_are_built_before_rosettify_plugins_and_the_generator():
    # F2-8 fix (P1 W1): deterministic hooks (pluginSyncBundles) read
    # <hooksSource>/dist/bundles/<target>/*.js, which only exists once src/hooks is built. Building
    # it here — before rosettify-plugins is installed/built, mirroring the plugin-drift job in
    # ci-release-guard.yml — means the generator never sees a missing dist/bundles dir.
    steps = _steps()
    names = [s.get("name") for s in steps]

    install_hooks = _step_named("Install hooks dependencies")
    assert install_hooks["run"].strip() == "npm ci"
    assert install_hooks["working-directory"] == "src/hooks"

    build_hooks = _step_named("Build hooks bundles")
    assert build_hooks["working-directory"] == "src/hooks"
    assert "build:quiet" in build_hooks["run"]

    assert names.index("Install hooks dependencies") < names.index("Build hooks bundles")
    assert names.index("Build hooks bundles") < names.index("Install rosettify-plugins dependencies")
    assert names.index("Install rosettify-plugins dependencies") < names.index("Build rosettify-plugins CLI")
    assert names.index("Build rosettify-plugins CLI") < names.index("Build org plugin set")


def test_setup_node_cache_covers_hooks_and_rosettify_plugins_lockfiles():
    setup_node = _step_named("Set up Node.js")
    cache_paths = setup_node["with"]["cache-dependency-path"]
    assert "src/hooks/package-lock.json" in cache_paths
    assert "src/rosettify-plugins/package-lock.json" in cache_paths


def test_verify_deterministic_hook_bundles_step_runs_only_when_hooks_are_deterministic():
    verify_step = _step_named("Verify deterministic hook bundles")
    assert verify_step.get("if") == "env.deterministic_hooks == 'true'"
    run = verify_step["run"]
    # Same bundle filename list as src/rosettify-plugins/src/plugin-processors/plugin-sync-bundles.ts
    # (BUNDLE_FILENAMES) — kept in sync by hand since this step must not import that TS module.
    for filename in (
        "dangerous-actions.js",
        "codemap-refresh.js",
        "lint-format-advisory.js",
        "loose-files.js",
        "md-file-advisory.js",
        "read-once.js",
        "read-once-reset.js",
    ):
        assert filename in run
    assert "hooks.json" in run
    assert "sys.exit(1)" in run

    steps = _steps()
    names = [s.get("name") for s in steps]
    assert names.index("Build org plugin set") < names.index("Verify deterministic hook bundles")
    assert names.index("Verify deterministic hook bundles") < names.index("Upload org plugin set artifact")


def _write_fixture_tree(root: Path, *, include_bundle_file: bool) -> None:
    # The step's own script hardcodes "${RUNNER_TEMP}/org-plugins-out", so each fixture tree lives
    # under its own RUNNER_TEMP with that exact directory name.
    hooks_dir = root / "org-plugins-out" / "core-claude" / "hooks"
    hooks_dir.mkdir(parents=True)
    (hooks_dir / "hooks.json").write_text(
        '{"hooks":{"PreToolUse":[{"hooks":[{"command":"node ${CLAUDE_PLUGIN_ROOT}/hooks/dangerous-actions.js"}]}]}}'
    )
    if include_bundle_file:
        (hooks_dir / "dangerous-actions.js").write_text("// ok")
    # else: deliberately not written, reproducing the original bug — hooks.json references a
    # bundle .js file that pluginSyncBundles never copied.


def test_verify_deterministic_hook_bundles_script_is_valid_python_and_catches_missing_bundles(tmp_path):
    # Executes the exact embedded script against a small fixture tree, so this test fails if the
    # heredoc's YAML indentation (which must line up so it strips to valid, unindented Python) ever
    # regresses, not just if the logic changes.
    run = _step_named("Verify deterministic hook bundles")["run"]
    env = {**os.environ}

    ok_root = tmp_path / "ok"
    _write_fixture_tree(ok_root, include_bundle_file=True)
    ok_result = subprocess.run(
        ["bash", "-c", run],
        env={**env, "RUNNER_TEMP": str(ok_root)},
        capture_output=True,
        text=True,
        check=False,
    )
    assert ok_result.returncode == 0, ok_result.stderr

    broken_root = tmp_path / "broken"
    _write_fixture_tree(broken_root, include_bundle_file=False)
    broken_result = subprocess.run(
        ["bash", "-c", run],
        env={**env, "RUNNER_TEMP": str(broken_root)},
        capture_output=True,
        text=True,
        check=False,
    )
    assert broken_result.returncode == 1
    assert "dangerous-actions.js" in broken_result.stdout


def test_upload_artifact_step_is_least_privilege_and_never_empty():
    upload_step = _step_named("Upload org plugin set artifact")
    # Matches the version used elsewhere in the repo's workflows (e.g. repo-plan.yml,
    # validate-prompts.yml, e2e-testing.yml) — was @v4 here, which drifted from the rest of the repo.
    assert upload_step["uses"] == "actions/upload-artifact@v6"
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


# --- W4: this test module itself must actually run in CI, not just exist on disk -----------------


def test_this_test_module_is_run_by_ci_release_guard():
    # P3 W4: nothing ran these regression checks in CI. ci-release-guard.yml already builds/tests
    # the plugin generation path (plugin-drift job) and is the closest existing gate to
    # build-org-plugins.yml, so it's the one workflow wired to pick this module up, rather than
    # adding a whole new workflow for one pytest file.
    assert CI_RELEASE_GUARD_PATH.is_file()
    guard = _load_ci_release_guard_workflow()
    plugin_drift = guard["jobs"]["plugin-drift"]
    steps = plugin_drift["steps"]

    pytest_steps = [s for s in steps if THIS_TEST_FILE_RELATIVE in (s.get("run") or "")]
    assert pytest_steps, (
        f"no step in ci-release-guard.yml's plugin-drift job runs {THIS_TEST_FILE_RELATIVE}; "
        "this regression suite is not wired into CI"
    )
    assert any("pytest" in s["run"] for s in pytest_steps), "expected a pytest invocation, not a bare python3 run"


def test_ci_release_guard_still_triggers_on_the_plugin_generation_path():
    # ci-release-guard.yml's plugin-drift job (and now this test module's own invocation inside
    # it) already triggers on the paths that actually drive build-org-plugins.yml's content —
    # instructions/**, plugins/**, src/rosettify-plugins/**, src/hooks/** — so any change that
    # would change what the generator produces still runs this suite. (Its path filter's exact
    # list is covered by ci-release-guard.yml's own test module, test_ci_release_guard_workflow.py,
    # which is not touched here.)
    guard = _load_ci_release_guard_workflow()
    on = guard.get("on", guard.get(True))
    for trigger in ("pull_request", "push"):
        paths = on[trigger]["paths"]
        for expected in ("instructions/**", "plugins/**", "src/rosettify-plugins/**", "src/hooks/**"):
            assert expected in paths, f"{trigger} paths: {paths!r}"
