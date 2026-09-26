"""E7: src/run-tests.sh must run every suite even when an earlier one fails,
and must exit non-zero with a summary of which suites failed - not abort at
the first failure (the old `set -euo pipefail` behaviour) and silently skip
the rest.
"""

from __future__ import annotations

import shutil
import stat
import subprocess
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
_RUN_TESTS_SH = _REPO_ROOT / "src" / "run-tests.sh"


def _make_executable(path: Path) -> None:
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _build_fake_repo(tmp_path: Path, failing_pytest_suite: str) -> Path:
    """A minimal repo layout run-tests.sh can execute against.

    Only the Python (pytest) suites are exercised here (node_modules is left
    absent for every TS package, so those are skipped with a WARNING, exactly
    as run-tests.sh already handles a missing install - not part of this fix).
    """
    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    shutil.copy(_RUN_TESTS_SH, repo / "src" / "run-tests.sh")
    _make_executable(repo / "src" / "run-tests.sh")

    (repo / "src" / "rosetta-mcp-server" / "tests").mkdir(parents=True)
    (repo / "src" / "rosetta-cli" / "tests").mkdir(parents=True)

    venv_bin = repo / "venv" / "bin"
    venv_bin.mkdir(parents=True)
    fake_pytest = venv_bin / "pytest"
    # Fails only for the suite named in `failing_pytest_suite` (matched against
    # the last CLI arg, the test directory path); succeeds for every other
    # invocation - mirrors "one suite is red, the rest are green".
    fake_pytest.write_text(
        "#!/bin/bash\n"
        f'if [[ "$*" == *"{failing_pytest_suite}"* ]]; then\n'
        '  echo "FAKE PYTEST: failing suite matched"\n'
        "  exit 1\n"
        "fi\n"
        'echo "FAKE PYTEST: ok"\n'
        "exit 0\n"
    )
    _make_executable(fake_pytest)

    return repo


def _run(repo: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(repo / "src" / "run-tests.sh")],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_later_pytest_suite_still_runs_after_an_earlier_one_fails(tmp_path):
    repo = _build_fake_repo(tmp_path, failing_pytest_suite="rosetta-mcp-server/tests")

    result = _run(repo)

    assert "Running rosetta-mcp-server tests" in result.stdout
    # This is the regression E7 fixes: under the old `set -e`, the script
    # would abort right after the first failure and never reach this line.
    assert "Running rosetta-cli tests" in result.stdout


def test_script_exits_non_zero_and_summarizes_failed_suites(tmp_path):
    repo = _build_fake_repo(tmp_path, failing_pytest_suite="rosetta-mcp-server/tests")

    result = _run(repo)

    assert result.returncode == 1, result.stdout + result.stderr
    assert "rosetta-mcp-server" in result.stdout


def test_script_exits_zero_when_everything_passes(tmp_path):
    repo = _build_fake_repo(tmp_path, failing_pytest_suite="__never_matches__")

    result = _run(repo)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Test validation passed" in result.stdout


def test_script_is_syntactically_valid_bash():
    result = subprocess.run(
        ["bash", "-n", str(_RUN_TESTS_SH)], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
