"""B8: rosetta-mcp and ims-mcp must declare a Python floor their deps can satisfy.

ragflow-sdk (a hard dependency of rosetta-mcp, and transitively of ims-mcp via
its rosetta-mcp pin) requires Python >=3.12. Declaring a lower floor lets pip
either fail with a confusing resolver error, or silently backtrack to an older,
stale rosetta-mcp release whose constraints happen to resolve.
"""

from __future__ import annotations

import sys
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - repo venv is 3.12
    import tomli as tomllib  # type: ignore[no-redef]

import pytest
from packaging.specifiers import SpecifierSet

_REPO_ROOT = Path(__file__).resolve().parents[3]

_PYPROJECT_PATHS = [
    _REPO_ROOT / "src" / "rosetta-mcp-server" / "pyproject.toml",
    _REPO_ROOT / "src" / "ims-mcp-server" / "pyproject.toml",
]


def _load(path: Path) -> dict:
    with path.open("rb") as f:
        return tomllib.load(f)


@pytest.mark.parametrize("pyproject_path", _PYPROJECT_PATHS, ids=lambda p: p.parent.name)
def test_requires_python_satisfies_ragflow_sdk_floor(pyproject_path: Path):
    data = _load(pyproject_path)
    requires_python = data["project"]["requires-python"]
    spec = SpecifierSet(requires_python)

    # ragflow-sdk 0.25.x declares `Requires-Python: <3.15,>=3.12`.
    assert not spec.contains("3.10"), f"{pyproject_path}: requires-python allows 3.10"
    assert not spec.contains("3.11"), f"{pyproject_path}: requires-python allows 3.11"
    assert spec.contains("3.12"), f"{pyproject_path}: requires-python excludes 3.12"


@pytest.mark.parametrize("pyproject_path", _PYPROJECT_PATHS, ids=lambda p: p.parent.name)
def test_no_stale_python_310_311_classifiers(pyproject_path: Path):
    data = _load(pyproject_path)
    classifiers = data["project"].get("classifiers", [])
    assert "Programming Language :: Python :: 3.10" not in classifiers
    assert "Programming Language :: Python :: 3.11" not in classifiers
