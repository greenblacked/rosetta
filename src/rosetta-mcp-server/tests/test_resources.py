from types import SimpleNamespace

import pytest

from rosetta_mcp.clients.doc_cache import InstructionDocCache
from rosetta_mcp.clients.document import DocumentClient
from rosetta_mcp.services.bundler import Bundler
from rosetta_mcp.tools.resources import normalize_resource_path, read_instruction_resource


def test_normalize_resource_path_slashes_and_whitespace():
    assert normalize_resource_path("  /skills/planning/SKILL.md  ") == "skills/planning/SKILL.md"


def test_normalize_resource_path_backslashes():
    assert normalize_resource_path(r"\skills\planning\SKILL.md") == "skills/planning/SKILL.md"


def test_normalize_resource_path_preserves_double_slash_for_validation():
    assert normalize_resource_path("skills//planning/SKILL.md") == "skills//planning/SKILL.md"


# ---------------------------------------------------------------------------
# B3: stale doc-cache id on a resource read must self-heal within one retry
# ---------------------------------------------------------------------------


class _FakeDoc:
    """Mimics a ragflow_sdk Document just enough for Bundler + DocumentClient."""

    def __init__(self, doc_id, server_docs):
        self.id = doc_id
        self.name = "SKILL.md"
        self.meta_fields = {"resource_path": "skills/x/SKILL.md", "tags": ["x"]}
        self._server_docs = server_docs

    def download(self):
        if self.id not in self._server_docs:
            raise Exception(f"You don't own the document {self.id}")
        return self._server_docs[self.id].encode()


class _FakeDataset:
    id = "ds"
    name = "aia-r3"

    def __init__(self, server_docs):
        self._server_docs = server_docs

    def list_documents(self, **_kwargs):
        return [_FakeDoc(doc_id, self._server_docs) for doc_id in self._server_docs]


def _make_call_ctx(dataset):
    return SimpleNamespace(
        config=SimpleNamespace(instruction_dataset="aia-r3"),
        authorizer=SimpleNamespace(can_read=lambda *_a: True),
        user_email="u@example.com",
        dataset_lookup=SimpleNamespace(get_dataset=lambda name: dataset),
    )


@pytest.mark.asyncio
async def test_read_instruction_resource_recovers_from_stale_cached_doc_id():
    """A publish that replaces a doc's id must not wedge reads for the TTL."""
    server_docs = {"old-id": "v1"}
    dataset = _FakeDataset(server_docs)
    document_client = DocumentClient()
    bundler = Bundler(document_client)
    doc_cache = InstructionDocCache(document_client, ttl=300)
    call_ctx = _make_call_ctx(dataset)

    before = await read_instruction_resource(
        "skills/x/SKILL.md", call_ctx, document_client, bundler, doc_cache
    )
    assert "v1" in before
    assert not before.startswith("Error:")

    # Simulate rosetta-cli publish: delete old id, upload under a new one.
    del server_docs["old-id"]
    server_docs["new-id"] = "v2"

    after = await read_instruction_resource(
        "skills/x/SKILL.md", call_ctx, document_client, bundler, doc_cache
    )

    assert not after.startswith("Error:")
    assert "v2" in after


@pytest.mark.asyncio
async def test_read_instruction_resource_returns_error_when_retry_also_fails():
    """If the doc is genuinely gone even after a refetch, surface an error string."""
    server_docs = {"old-id": "v1"}
    dataset = _FakeDataset(server_docs)
    document_client = DocumentClient()
    bundler = Bundler(document_client)
    doc_cache = InstructionDocCache(document_client, ttl=300)
    call_ctx = _make_call_ctx(dataset)

    before = await read_instruction_resource(
        "skills/x/SKILL.md", call_ctx, document_client, bundler, doc_cache
    )
    assert "v1" in before

    # The doc disappears entirely: list_documents will no longer offer it.
    del server_docs["old-id"]

    after = await read_instruction_resource(
        "skills/x/SKILL.md", call_ctx, document_client, bundler, doc_cache
    )
    assert after.startswith("Error: No documents found for resource path")
