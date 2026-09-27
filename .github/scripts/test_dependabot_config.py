"""Regression checks for .github/dependabot.yml.

Run: python3 -m pytest .github/scripts/test_dependabot_config.py
"""
from pathlib import Path

import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEPENDABOT_PATH = REPOSITORY_ROOT / ".github" / "dependabot.yml"


def _load() -> dict:
    return yaml.safe_load(DEPENDABOT_PATH.read_text(encoding="utf-8"))


def _entries(config: dict, ecosystem: str) -> list[dict]:
    return [u for u in config["updates"] if u["package-ecosystem"] == ecosystem]


def test_version_is_2():
    assert _load()["version"] == 2


def test_every_npm_package_with_a_lockfile_has_an_entry():
    config = _load()
    npm_dirs = {e["directory"] for e in _entries(config, "npm")}
    expected = {
        f"/src/{lockfile.parent.name}"
        for lockfile in (REPOSITORY_ROOT / "src").glob("*/package-lock.json")
    }
    assert npm_dirs == expected


def test_pip_covers_root_requirements_and_python_packages():
    config = _load()
    pip_dirs = {e["directory"] for e in _entries(config, "pip")}
    assert "/" in pip_dirs  # root requirements.txt (rosetta-cli + rosetta-mcp-server editable installs)
    for package in ("rosetta-cli", "rosetta-mcp-server", "ims-mcp-server"):
        pyproject = REPOSITORY_ROOT / "src" / package / "pyproject.toml"
        assert pyproject.is_file(), f"expected {pyproject} to exist"
        assert f"/src/{package}" in pip_dirs


def test_github_actions_ecosystem_present_for_workflows_and_composite_actions():
    config = _load()
    gha_dirs = {e["directory"] for e in _entries(config, "github-actions")}
    assert "/" in gha_dirs
    for action_dir in (REPOSITORY_ROOT / ".github" / "actions").iterdir():
        if (action_dir / "action.yml").is_file() or (action_dir / "action.yaml").is_file():
            assert f"/.github/actions/{action_dir.name}" in gha_dirs


def test_every_entry_is_weekly_grouped_and_capped():
    config = _load()
    for entry in config["updates"]:
        assert entry["schedule"]["interval"] == "weekly", entry
        assert entry["open-pull-requests-limit"] <= 10, entry
        assert set(entry["groups"]["minor-and-patch"]["update-types"]) == {"minor", "patch"}
