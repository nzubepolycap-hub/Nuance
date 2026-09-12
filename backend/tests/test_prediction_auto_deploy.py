"""Tests for services/genlayer_deploy.py's deploy_prediction_contract —
the prediction-market equivalent of deploy_escrow_contract. Mocks
deploy_contract entirely (no subprocess, no real network, no real testnet
GEN spent).

Covers:
  1. Happy path: links contract_address, and passes the right constructor
     args (question/resolution_url/resolution_criteria/cutoff_time).
  2. A market with no resolution_source_url is skipped — deploy_contract
     is never even called, since resolve_market has nothing to check
     against.
  3. A failed deploy (deploy_contract returns None) leaves the market
     unlinked.
  4. An already-linked market is left alone — deploy_contract never called.
  5. FIXED 2026-09-12 — a pending_review market (routers/predictions.py's
     create_prediction) flips to open on a successful deploy, the actual
     activation step for that endpoint's on-chain-only markets.
  6. An already-open market's status_key is left alone by a successful
     deploy (market_generator.py's auto-published rows are already open
     from the start; this must stay a no-op for them).
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from datetime import datetime, timedelta, timezone

_TMP_DIR = tempfile.mkdtemp(prefix="nuance-prediction-auto-deploy-test-")
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_TMP_DIR}/test.db")
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-pytest-only-32bytes+")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app.services.genlayer_deploy as genlayer_deploy  # noqa: E402
from app.db import AsyncSessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Prediction  # noqa: E402

_FAKE_ADDRESS = "0xF00Dbabe00000000000000000000000000000099"


@pytest.fixture(scope="module", autouse=True)
def _init_schema():
    with TestClient(app):
        yield


async def _create_prediction(
    resolution_source_url: str | None,
    contract_address: str | None = None,
    status_key: str = "open",
) -> int:
    async with AsyncSessionLocal() as db:
        prediction = Prediction(
            title="Will GenLayer ship mainnet by Q1?",
            description="Resolves YES if genlayer.com announces mainnet launch.",
            category="GENLAYER",
            resolution_date=datetime.now(timezone.utc) + timedelta(days=30),
            volume=0,
            status_key=status_key,
            resolution_source_url=resolution_source_url,
            contract_address=contract_address,
        )
        db.add(prediction)
        await db.commit()
        await db.refresh(prediction)
        return prediction.id


async def _get_prediction(prediction_id: int) -> Prediction:
    async with AsyncSessionLocal() as db:
        return await db.get(Prediction, prediction_id)


def test_deploys_and_links_correctly(monkeypatch):
    prediction_id = asyncio.run(_create_prediction("https://genlayer.com/blog/mainnet"))

    captured = {}

    async def _fake_deploy_contract(file, args):
        captured["file"] = file
        captured["args"] = args
        return _FAKE_ADDRESS

    monkeypatch.setattr(genlayer_deploy, "deploy_contract", _fake_deploy_contract)

    asyncio.run(genlayer_deploy.deploy_prediction_contract(prediction_id))

    prediction = asyncio.run(_get_prediction(prediction_id))
    assert prediction.contract_address == _FAKE_ADDRESS

    assert captured["file"] == "nuance_prediction_market.py"
    question, resolution_url, resolution_criteria, cutoff_time = captured["args"]
    assert question == "Will GenLayer ship mainnet by Q1?"
    assert resolution_url == "https://genlayer.com/blog/mainnet"
    assert resolution_criteria == "Resolves YES if genlayer.com announces mainnet launch."
    assert isinstance(cutoff_time, str)


def test_skips_market_with_no_resolution_url(monkeypatch):
    prediction_id = asyncio.run(_create_prediction(resolution_source_url=None))

    def _fail_if_called(file, args):
        raise AssertionError("deploy_contract should never be called with no resolution_source_url")

    monkeypatch.setattr(genlayer_deploy, "deploy_contract", _fail_if_called)

    asyncio.run(genlayer_deploy.deploy_prediction_contract(prediction_id))  # must not raise

    prediction = asyncio.run(_get_prediction(prediction_id))
    assert prediction.contract_address is None


def test_failed_deploy_leaves_it_unlinked(monkeypatch):
    prediction_id = asyncio.run(_create_prediction("https://example.com/some-source"))

    async def _fake_deploy_contract(file, args):
        return None

    monkeypatch.setattr(genlayer_deploy, "deploy_contract", _fake_deploy_contract)

    asyncio.run(genlayer_deploy.deploy_prediction_contract(prediction_id))

    prediction = asyncio.run(_get_prediction(prediction_id))
    assert prediction.contract_address is None


def test_pending_review_flips_to_open_on_successful_deploy(monkeypatch):
    prediction_id = asyncio.run(
        _create_prediction("https://genlayer.com/blog/mainnet", status_key="pending_review")
    )

    async def _fake_deploy_contract(file, args):
        return _FAKE_ADDRESS

    monkeypatch.setattr(genlayer_deploy, "deploy_contract", _fake_deploy_contract)

    asyncio.run(genlayer_deploy.deploy_prediction_contract(prediction_id))

    prediction = asyncio.run(_get_prediction(prediction_id))
    assert prediction.contract_address == _FAKE_ADDRESS
    assert prediction.status_key == "open"


def test_already_open_market_status_untouched_by_deploy(monkeypatch):
    prediction_id = asyncio.run(
        _create_prediction("https://genlayer.com/blog/mainnet", status_key="open")
    )

    async def _fake_deploy_contract(file, args):
        return _FAKE_ADDRESS

    monkeypatch.setattr(genlayer_deploy, "deploy_contract", _fake_deploy_contract)

    asyncio.run(genlayer_deploy.deploy_prediction_contract(prediction_id))

    prediction = asyncio.run(_get_prediction(prediction_id))
    assert prediction.contract_address == _FAKE_ADDRESS
    assert prediction.status_key == "open"


def test_skips_already_linked_market(monkeypatch):
    prediction_id = asyncio.run(
        _create_prediction("https://example.com/some-source", contract_address="0xAlreadyLinked")
    )

    def _fail_if_called(file, args):
        raise AssertionError("deploy_contract should never be called for an already-linked market")

    monkeypatch.setattr(genlayer_deploy, "deploy_contract", _fail_if_called)

    asyncio.run(genlayer_deploy.deploy_prediction_contract(prediction_id))  # must not raise

    prediction = asyncio.run(_get_prediction(prediction_id))
    assert prediction.contract_address == "0xAlreadyLinked"
