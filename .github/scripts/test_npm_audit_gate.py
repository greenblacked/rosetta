"""Unit tests for the npm audit severity gate used by ci-release-guard.yml.

Run: python3 -m pytest .github/scripts/test_npm_audit_gate.py
"""
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "npm_audit_gate", pathlib.Path(__file__).with_name("npm_audit_gate.py")
)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


def vulns(**levels):
    base = {level: 0 for level in module.SEVERITY_ORDER}
    base.update(levels)
    return base


def test_default_gate_only_fails_on_critical():
    failed, _ = module.evaluate({"metadata": {"vulnerabilities": vulns(high=2, moderate=6)}}, "critical")
    assert failed is False


def test_default_gate_fails_on_critical():
    failed, _ = module.evaluate({"metadata": {"vulnerabilities": vulns(critical=1)}}, "critical")
    assert failed is True


def test_todays_baseline_findings_pass_the_critical_gate():
    """Regression guard: curiocity, rosettify and rosettify-plugins carry existing,
    unfixed `high` findings (see docs/ARCHITECTURE.md#ci-release-guard). The gate
    must not start failing on them without a deliberate policy change."""
    for report in (
        vulns(high=1),               # curiocity: extract-zip
        vulns(high=2, moderate=6),   # rosettify: fast-uri/hono/qs
        vulns(high=2),               # rosettify-plugins: js-yaml
    ):
        failed, _ = module.evaluate({"metadata": {"vulnerabilities": report}}, "critical")
        assert failed is False


def test_count_at_or_above_sums_only_the_named_tier_and_above():
    assert module.count_at_or_above(vulns(low=3, moderate=2, high=1), "high") == 1
    assert module.count_at_or_above(vulns(low=3, moderate=2, high=1), "moderate") == 3
    assert module.count_at_or_above(vulns(low=3, moderate=2, high=1), "low") == 6


def test_count_at_or_above_treats_missing_keys_as_zero():
    assert module.count_at_or_above({}, "critical") == 0


def test_summarize_lists_every_severity_lowest_to_highest():
    assert module.summarize(vulns(high=2, critical=0)) == (
        "info=0, low=0, moderate=0, high=2, critical=0"
    )


def test_evaluate_returns_the_raw_vulnerabilities_dict():
    report = {"metadata": {"vulnerabilities": vulns(moderate=1)}}
    _, vulnerabilities = module.evaluate(report, "critical")
    assert vulnerabilities == vulns(moderate=1)


def test_evaluate_tolerates_missing_metadata():
    failed, vulnerabilities = module.evaluate({}, "critical")
    assert failed is False
    assert vulnerabilities == {}
