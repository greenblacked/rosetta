"""E6: local-dev setup commands documented outside this package must actually work.

`.env.dev` / `.env.prod` are gitignored (only `env.template` is committed), so
`cp .env.dev .env` (or `cp src/rosetta-cli/.env.dev .env`) fails on a fresh
clone with "No such file or directory". The docs must instead point at the
committed `env.template`, and any `uvx rosetta-cli@latest publish <path>`
snippet must use a path that resolves from where the snippet is run.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

_DOC_PATHS = [
    REPO_ROOT / "DEVELOPER_GUIDE.md",
    REPO_ROOT / "TROUBLESHOOTING.md",
    REPO_ROOT / "src" / "rosetta-cli" / "README.md",
]


def test_env_template_is_the_file_actually_committed():
    template = REPO_ROOT / "src" / "rosetta-cli" / "env.template"
    assert template.exists(), "src/rosetta-cli/env.template must exist and be committed"


def test_docs_no_longer_reference_the_gitignored_env_dev_file():
    for doc_path in _DOC_PATHS:
        text = doc_path.read_text(encoding="utf-8")
        assert ".env.dev" not in text, f"{doc_path}: still references the gitignored .env.dev"
        assert ".env.prod" not in text, f"{doc_path}: still references the gitignored .env.prod"


def test_docs_point_at_the_committed_env_template():
    for doc_path in _DOC_PATHS:
        text = doc_path.read_text(encoding="utf-8")
        if "cp " in text and " .env" in text:
            assert "env.template" in text, (
                f"{doc_path}: has a 'cp ... .env' snippet but never mentions env.template"
            )


def test_developer_guide_publish_snippet_uses_a_path_that_resolves_from_repo_root():
    text = (REPO_ROOT / "DEVELOPER_GUIDE.md").read_text(encoding="utf-8")
    lines = text.splitlines()

    # Find every `uvx rosetta-cli@latest publish ...` snippet that is not
    # preceded (within the same fenced block) by a `cd src/rosetta-cli`.
    for i, line in enumerate(lines):
        if "uvx rosetta-cli@latest publish" not in line:
            continue
        # Walk back to the start of the fenced code block this line is in.
        block_start = i
        while block_start > 0 and not lines[block_start].strip().startswith("```"):
            block_start -= 1
        block = lines[block_start:i]
        cds_into_cli_dir = any(ln.strip().startswith("cd src/rosetta-cli") for ln in block)

        if cds_into_cli_dir:
            assert "../../instructions" in line or "../instructions" in line
        else:
            # Run from the repo root: the instructions folder is just "instructions".
            assert "../instructions" not in line, (
                f"Line {i + 1} publishes '../instructions' from the repo root, "
                f"which resolves outside the repo: {line!r}"
            )
            assert (REPO_ROOT / "instructions").is_dir()
