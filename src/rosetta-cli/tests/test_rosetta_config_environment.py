"""Environment-label resolution in RosettaConfig (issue #297).

Precedence: explicit argument (--env) > ENVIRONMENT > keyword detected in
RAGFLOW_BASE_URL > "local".

Before the fix, detection took the URL's first subdomain, so the built-in default
`http://ragflow.local` resolved to "ragflow" - contradicting both the documented
default and the dataclass field default of "local". Nothing in this path had any
test coverage.
"""

import pytest

from rosetta_cli.rosetta_config import (
    ENVIRONMENT_KEYWORDS,
    RosettaConfig,
    _environment_from_url,
)


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch):
    """Isolate every test from the developer's own shell environment."""
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("RAGFLOW_BASE_URL", raising=False)
    monkeypatch.setenv("RAGFLOW_API_KEY", "ragflow-test")


# --- the keyword table itself -------------------------------------------------


def test_environment_keyword_order_is_safe():
    """ORDER IS LOAD-BEARING: a keyword containing another must be scanned first.

    This guards the tuple against being alphabetized or sorted later. It derives
    the containment pairs rather than hard-coding them, so it keeps holding if
    keywords are added.
    """
    order = list(ENVIRONMENT_KEYWORDS)
    for outer in order:
        for inner in order:
            if outer != inner and inner in outer:
                assert order.index(outer) < order.index(inner), (
                    f"{outer!r} contains {inner!r} and must be listed before it, "
                    f"otherwise a URL containing {outer!r} resolves to {inner!r}"
                )


def test_prod_is_the_only_containment_pair():
    """Documents why the tuple needs an order at all - if this fails, re-read
    the ordering comment before adding the new keyword."""
    pairs = {
        (outer, inner)
        for outer in ENVIRONMENT_KEYWORDS
        for inner in ENVIRONMENT_KEYWORDS
        if outer != inner and inner in outer
    }
    assert pairs == {("preprod", "prod")}


@pytest.mark.parametrize("keyword", ENVIRONMENT_KEYWORDS)
def test_every_keyword_is_detectable(keyword):
    """Each keyword resolves to itself when it appears in a URL."""
    assert _environment_from_url(f"https://ragflow-{keyword}.example.com") == keyword


# --- detection from the URL ---------------------------------------------------


@pytest.mark.parametrize(
    "url, expected",
    [
        # The issue's own case: the built-in default must yield "local".
        ("http://ragflow.local", None),
        ("http://localhost:9380", None),
        ("https://ragflow.example.com", None),
        # Ordering guard - "prod" is a substring of "preprod".
        ("https://preprod.example.com", "preprod"),
        ("https://ragflow-preprod.corp.io/api", "preprod"),
        ("https://prod.example.com", "prod"),
        # The resolved value is the keyword, not the surrounding label. This is a
        # deliberate change: previously "ims-dev.example.com" yielded "ims-dev".
        ("https://ims-dev.example.com/", "dev"),
        ("https://ims-qa.example.com", "qa"),
        # Case-insensitive.
        ("https://RAGFLOW-PROD.EXAMPLE.COM", "prod"),
        ("https://Ims-Stag.example.com", "stag"),
        # Scanned as given - scheme, port and path all count.
        ("http://10.0.0.5:8080/uat-api", "uat"),
        # Substring matching also fires on incidental hits: a hostname that merely
        # contains a keyword resolves to it. Inherent to "basic string contains";
        # pinned so the behaviour is documented rather than discovered.
        ("https://advantest.example.com", "test"),
        ("https://prodigy.example.com", "prod"),
        ("", None),
    ],
)
def test_environment_from_url(url, expected):
    assert _environment_from_url(url) == expected


def test_first_match_wins_when_a_url_carries_two_keywords():
    """Scan order decides, per the documented rule."""
    assert _environment_from_url("https://dev-and-qa.example.com") == "qa"
    assert ENVIRONMENT_KEYWORDS.index("qa") < ENVIRONMENT_KEYWORDS.index("dev")


# --- end-to-end precedence through from_env_vars ------------------------------


def test_bare_install_default_url_resolves_to_local():
    """#297: only RAGFLOW_API_KEY set -> "local", not "ragflow"."""
    config = RosettaConfig.from_env_vars()

    assert config.base_url == "http://ragflow.local"
    assert config.environment == "local"


def test_bare_install_matches_the_dataclass_field_default():
    """The resolver and the `environment: str = "local"` field default now agree."""
    from_env = RosettaConfig.from_env_vars()
    bare = RosettaConfig(base_url="http://ragflow.local", api_key="ragflow-test")

    assert from_env.environment == bare.environment == "local"


def test_url_without_any_keyword_resolves_to_local(monkeypatch):
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow.internal.example.com")

    assert RosettaConfig.from_env_vars().environment == "local"


def test_prod_url_resolves_to_prod(monkeypatch):
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow-prod.example.com")

    assert RosettaConfig.from_env_vars().environment == "prod"


def test_preprod_url_resolves_to_preprod_not_prod(monkeypatch):
    """The ordering guard, end to end."""
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow-preprod.example.com")

    assert RosettaConfig.from_env_vars().environment == "preprod"


def test_environment_variable_wins_over_url_detection(monkeypatch):
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow-prod.example.com")
    monkeypatch.setenv("ENVIRONMENT", "whatever-i-said")

    assert RosettaConfig.from_env_vars().environment == "whatever-i-said"


def test_explicit_argument_wins_over_environment_variable_and_url(monkeypatch):
    """`--env` keeps top precedence."""
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow-prod.example.com")
    monkeypatch.setenv("ENVIRONMENT", "from-env-var")

    config = RosettaConfig.from_env_vars(environment="from-cli-flag")

    assert config.environment == "from-cli-flag"


def test_explicit_argument_wins_for_the_default_url():
    assert RosettaConfig.from_env_vars(environment="dev").environment == "dev"


# --- B1: explicit --env / --env-file must override pre-existing shell env -----


def test_explicit_environment_overrides_preexisting_shell_env(tmp_path, monkeypatch):
    """`--env dev` must win even if the shell already exported prod values."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow-prod.example.com")
    monkeypatch.setenv("RAGFLOW_API_KEY", "ragflow-PRODKEY")

    (tmp_path / ".env.dev").write_text(
        "RAGFLOW_BASE_URL=https://ragflow-dev.example.com\n"
        "RAGFLOW_API_KEY=ragflow-DEVKEY\n"
    )

    config = RosettaConfig.from_env(environment="dev")

    assert config.base_url == "https://ragflow-dev.example.com"
    assert config.api_key == "ragflow-DEVKEY"


def test_env_name_with_env_file_var_overrides_shell_env(tmp_path, monkeypatch):
    """`--env NAME` combined with ROSETTA_CLI_ENV_FILE must still override.

    When the file is selected via ROSETTA_CLI_ENV_FILE (itself an explicit,
    user-chosen file - see ENV_FILE_ENV_VAR and find_env_file()), that choice
    is explicit even though its basename isn't `.env.<NAME>`. Regression: this
    previously fell through to the non-overriding "generic .env fallback"
    path and silently kept the pre-existing shell env.
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow-prod.example.com")
    monkeypatch.setenv("RAGFLOW_API_KEY", "ragflow-PRODKEY")

    env_file = tmp_path / "custom.env"
    env_file.write_text(
        "RAGFLOW_BASE_URL=https://ragflow-dev.example.com\n"
        "RAGFLOW_API_KEY=ragflow-DEVKEY\n"
    )
    monkeypatch.setenv("ROSETTA_CLI_ENV_FILE", str(env_file))

    config = RosettaConfig.from_env(environment="dev")

    assert config.base_url == "https://ragflow-dev.example.com"
    assert config.api_key == "ragflow-DEVKEY"


def test_explicit_env_file_overrides_preexisting_shell_env(tmp_path, monkeypatch):
    """An explicit `--env-file` path must also win over pre-existing shell env."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow-prod.example.com")
    monkeypatch.setenv("RAGFLOW_API_KEY", "ragflow-PRODKEY")

    env_file = tmp_path / "custom.env"
    env_file.write_text(
        "RAGFLOW_BASE_URL=https://ragflow-dev.example.com\n"
        "RAGFLOW_API_KEY=ragflow-DEVKEY\n"
    )

    config = RosettaConfig.from_env(env_file=str(env_file))

    assert config.base_url == "https://ragflow-dev.example.com"
    assert config.api_key == "ragflow-DEVKEY"


def test_auto_discovered_env_file_does_not_override_shell_env(tmp_path, monkeypatch):
    """Without an explicit --env/--env-file, shell env vars keep precedence."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow-prod.example.com")
    monkeypatch.setenv("RAGFLOW_API_KEY", "ragflow-PRODKEY")

    (tmp_path / ".env").write_text(
        "RAGFLOW_BASE_URL=https://ragflow-dev.example.com\n"
        "RAGFLOW_API_KEY=ragflow-DEVKEY\n"
    )

    config = RosettaConfig.from_env()

    assert config.base_url == "https://ragflow-prod.example.com"
    assert config.api_key == "ragflow-PRODKEY"


# --- R8: `--env NAME` falling back to a generic .env must NOT override --------


def test_env_name_falling_back_to_generic_dotenv_does_not_override_shell_env(
    tmp_path, monkeypatch
):
    """`--env production` in CI must not let a stray local `.env` win.

    If `.env.production` does not exist, `find_env_file("production")` falls
    back to the generic `.env`. That fallback is auto-discovery, not an
    explicit choice of the "production" file, so it must not override
    CI-exported RAGFLOW_* vars (regression for R8).
    """
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow-ci.example.com")
    monkeypatch.setenv("RAGFLOW_API_KEY", "ragflow-CIKEY")

    # No .env.production present, only a generic, developer-local .env.
    (tmp_path / ".env").write_text(
        "RAGFLOW_BASE_URL=https://ragflow-local.example.com\n"
        "RAGFLOW_API_KEY=ragflow-LOCALKEY\n"
    )

    config = RosettaConfig.from_env(environment="production")

    assert config.base_url == "https://ragflow-ci.example.com"
    assert config.api_key == "ragflow-CIKEY"


def test_env_name_resolving_to_specific_dotenv_does_override_shell_env(
    tmp_path, monkeypatch
):
    """`--env dev` still overrides shell env when `.env.dev` actually exists."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("RAGFLOW_BASE_URL", "https://ragflow-prod.example.com")
    monkeypatch.setenv("RAGFLOW_API_KEY", "ragflow-PRODKEY")

    (tmp_path / ".env.dev").write_text(
        "RAGFLOW_BASE_URL=https://ragflow-dev.example.com\n"
        "RAGFLOW_API_KEY=ragflow-DEVKEY\n"
    )
    # A generic .env is also present but must be ignored in favor of .env.dev.
    (tmp_path / ".env").write_text(
        "RAGFLOW_BASE_URL=https://ragflow-generic.example.com\n"
        "RAGFLOW_API_KEY=ragflow-GENERICKEY\n"
    )

    config = RosettaConfig.from_env(environment="dev")

    assert config.base_url == "https://ragflow-dev.example.com"
    assert config.api_key == "ragflow-DEVKEY"
