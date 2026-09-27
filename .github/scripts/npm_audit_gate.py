#!/usr/bin/env python3
"""npm audit gate for ci-release-guard.yml's `audit` job.

Runs `npm audit --omit=dev --json` in a package directory and applies a
severity gate. Today's baseline (see docs/ARCHITECTURE.md#ci-release-guard)
has existing `high` findings with no upstream fix (curiocity's `extract-zip`,
rosettify's `fast-uri`/`qs`/`hono`, rosettify-plugins' `js-yaml`), so the gate
fails the job only on `critical` and reports `high`/`moderate` as a warning
annotation plus a job-summary row, so new criticals are blocked without
turning pre-existing, unfixable highs into a permanently red pipeline.

Run: python3 .github/scripts/npm_audit_gate.py --dir src/<package>
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]

# Ordered low -> high. The gate fails when the count at or above --fail-at is
# non-zero; everything below that is reported but does not fail the job.
SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"]

DEFAULT_FAIL_AT = "critical"


def count_at_or_above(vulnerabilities: dict, fail_at: str) -> int:
    """Sum vulnerability counts at or above `fail_at` in SEVERITY_ORDER."""
    threshold = SEVERITY_ORDER.index(fail_at)
    return sum(
        int(vulnerabilities.get(level, 0) or 0)
        for level in SEVERITY_ORDER[threshold:]
    )


def summarize(vulnerabilities: dict) -> str:
    """One-line severity breakdown, lowest to highest, for logs and the summary."""
    return ", ".join(
        f"{level}={int(vulnerabilities.get(level, 0) or 0)}" for level in SEVERITY_ORDER
    )


def evaluate(report: dict, fail_at: str) -> tuple[bool, dict]:
    """Return (should_fail, vulnerabilities) for a parsed `npm audit --json` report.

    `should_fail` is True only when the count at or above `fail_at` is non-zero.
    """
    vulnerabilities = report.get("metadata", {}).get("vulnerabilities", {})
    return count_at_or_above(vulnerabilities, fail_at) > 0, vulnerabilities


def run_npm_audit(package_dir: Path) -> dict:
    """Run `npm audit --omit=dev --json` in package_dir and parse its JSON output.

    npm audit exits non-zero whenever it finds any vulnerability, so the exit
    code is intentionally ignored here -- `evaluate()` is what decides pass/fail.
    """
    result = subprocess.run(
        ["npm", "audit", "--omit=dev", "--json"],
        cwd=package_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    stdout = result.stdout.strip()
    if not stdout:
        raise RuntimeError(
            f"npm audit produced no output in {package_dir} (stderr: {result.stderr.strip()})"
        )
    return json.loads(stdout)


def write_job_summary(package_dir: Path, vulnerabilities: dict, failed: bool) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    line = f"| `{package_dir}` | {summarize(vulnerabilities)} | {'FAIL' if failed else 'ok'} |\n"
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write(line)
    else:
        print(line, end="")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", required=True, help="Package directory relative to the repo root")
    parser.add_argument(
        "--fail-at",
        default=DEFAULT_FAIL_AT,
        choices=SEVERITY_ORDER,
        help=f"Minimum severity that fails the job (default: {DEFAULT_FAIL_AT})",
    )
    args = parser.parse_args(argv)

    package_dir = (REPOSITORY_ROOT / args.dir).resolve()
    report = run_npm_audit(package_dir)
    failed, vulnerabilities = evaluate(report, args.fail_at)

    write_job_summary(Path(args.dir), vulnerabilities, failed)

    if failed:
        print(
            f"::error::{args.dir}: npm audit found a {args.fail_at}-or-above "
            f"vulnerability ({summarize(vulnerabilities)}). Run `npm audit --omit=dev` "
            f"in {args.dir} and fix or pin the dependency.",
            file=sys.stderr,
        )
        return 1

    high_or_above = count_at_or_above(vulnerabilities, "high")
    if high_or_above:
        print(
            f"::warning::{args.dir}: npm audit found {high_or_above} high-or-above "
            f"finding(s) below the {args.fail_at} gate ({summarize(vulnerabilities)}). "
            "Not blocking -- see docs/ARCHITECTURE.md#ci-release-guard."
        )

    print(f"{args.dir}: {summarize(vulnerabilities)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
