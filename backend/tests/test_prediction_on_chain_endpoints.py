"""Tests for the on-chain prediction-market endpoints in routers/predictions.py:
  - POST /predictions/{id}/bet/on-chain (place_bet_on_chain)
  - the on-chain guard added to POST /predictions/{id}/resolve

Covers:
  1. place_bet_on_chain happy path: mirrors the stake into a
     PredictionPosition row and bumps volume, same bookkeeping as the
     off-chain bet endpoint.
  2. place_bet_on_chain rejects a market with no contract_address (400).
  3. place_bet_on_chain rejects a malformed tx_hash (422, from the schema
     itself, before any endpoint logic runs).
  4. resolve_prediction rejects an on-chain-linked market (400) — it
     resolves on-chain automatically via the indexer instead.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from datetime import datetime, timedelta, timezone

_TMP_DIR = tempfile.mkdtemp(prefix="nuance-prediction-onchain-endpoints-test-")
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_TMP_DIR}/test.db")
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-pytest-only-32bytes+")

from eth_account import Account  # noqa: E402
from eth_account.messages import encode_defunct  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import AsyncSessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Prediction  # noqa: E402

_FAKE_TX_HASH = "0x" + "ee" * 32
_CONTRACT_ADDRESS = "0xF34c75330bEd61B7e559e554a5628b4fa50CDd24"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _get_token(client: TestClient, wallet: Account) -> str:
    message = client.post("/auth/nonce", json={"wallet_address": wallet.address}).json()["message"]
    signed = wallet.sign_message(encode_defunct(text=message))
    resp = client.post(
        "/auth/verify",
        json={"wallet_address": wallet.address, "message": message, "signature": signed.signature.hex()},
    )
    assert resp.status_code == 200
    return resp.json()["access_token"]


async def _create_prediction(
    contract_address: str | None,
    status_key: str = "open",
    resolution_date: datetime | None = None,
) -> int:
    async with AsyncSessionLocal() as db:
        prediction = Prediction(
            title="Test market",
            description="Test description",
            category="TEST",
            resolution_date=resolution_date or (datetime.now(timezone.utc) + timedelta(days=1)),
            volume=0,
            status_key=status_key,
            contract_address=contract_address,
        )
        db.add(prediction)
        await db.commit()
        await db.refresh(prediction)
        return prediction.id


def test_place_bet_on_chain_happy_path(client: TestClient):
    wallet = Account.create()
    token = _get_token(client, wallet)
    prediction_id = asyncio.run(_create_prediction(_CONTRACT_ADDRESS))

    resp = client.post(
        f"/predictions/{prediction_id}/bet/on-chain",
        json={"tx_hash": _FAKE_TX_HASH, "side": "yes", "amount": 500},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["volume"] == 500
    assert len(body["positions"]) == 1
    position = body["positions"][0]
    assert position["side"] == "YES"
    assert position["amount"] == 500
    assert position["wallet_address"] == wallet.address.lower()


def test_place_bet_on_chain_rejects_unlinked_market(client: TestClient):
    wallet = Account.create()
    token = _get_token(client, wallet)
    prediction_id = asyncio.run(_create_prediction(None))

    resp = client.post(
        f"/predictions/{prediction_id}/bet/on-chain",
        json={"tx_hash": _FAKE_TX_HASH, "side": "yes", "amount": 500},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 400


def test_place_bet_on_chain_rejects_malformed_hash(client: TestClient):
    wallet = Account.create()
    token = _get_token(client, wallet)
    prediction_id = asyncio.run(_create_prediction(_CONTRACT_ADDRESS))

    resp = client.post(
        f"/predictions/{prediction_id}/bet/on-chain",
        json={"tx_hash": "not-a-hash", "side": "yes", "amount": 500},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_place_bet_on_chain_rejects_non_preset_amount(client: TestClient):
    """The quick-pick buttons (0.5/1/2/3 GEN = 500/1000/2000/3000
    milli-GEN — see BET_AMOUNTS_MILLI_GEN) are the only way to bet in the
    UI; the backend enforces that set too, not just the free-text `gt=0`
    bound, since the frontend can't be trusted to enforce it alone."""
    wallet = Account.create()
    token = _get_token(client, wallet)
    prediction_id = asyncio.run(_create_prediction(_CONTRACT_ADDRESS))

    resp = client.post(
        f"/predictions/{prediction_id}/bet/on-chain",
        json={"tx_hash": _FAKE_TX_HASH, "side": "yes", "amount": 750},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_place_bet_on_chain_rejects_a_closed_market(client: TestClient):
    """Regression test for a real security-review finding (2026-09-09,
    fixed 2026-09-10): place_bet_on_chain used to skip the same "is this
    market actually open" check place_bet enforces, letting a bet land
    on an already-resolved market and skew services/payout.py's
    pari-mutuel math for every other real bettor. See
    _assert_market_open_for_betting's own docstring."""
    wallet = Account.create()
    token = _get_token(client, wallet)
    prediction_id = asyncio.run(_create_prediction(_CONTRACT_ADDRESS, status_key="resolved"))

    resp = client.post(
        f"/predictions/{prediction_id}/bet/on-chain",
        json={"tx_hash": _FAKE_TX_HASH, "side": "yes", "amount": 500},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 400
    assert "not open" in resp.json()["detail"].lower()


def test_place_bet_on_chain_rejects_a_market_past_its_deadline(client: TestClient):
    """Same regression as test_place_bet_on_chain_rejects_a_closed_market
    above, the other half of the guard: still `status_key == "open"` (the
    indexer hasn't caught up to flip it yet — a real, expected window,
    not a contrived case) but already past its own resolution_date."""
    wallet = Account.create()
    token = _get_token(client, wallet)
    prediction_id = asyncio.run(
        _create_prediction(
            _CONTRACT_ADDRESS,
            status_key="open",
            resolution_date=datetime.now(timezone.utc) - timedelta(hours=1),
        )
    )

    resp = client.post(
        f"/predictions/{prediction_id}/bet/on-chain",
        json={"tx_hash": _FAKE_TX_HASH, "side": "yes", "amount": 500},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 400
    assert "closed" in resp.json()["detail"].lower()


def test_resolve_prediction_rejects_on_chain_linked_market(client: TestClient):
    prediction_id = asyncio.run(_create_prediction(_CONTRACT_ADDRESS))

    resp = client.post(f"/predictions/{prediction_id}/resolve")
    assert resp.status_code == 400
