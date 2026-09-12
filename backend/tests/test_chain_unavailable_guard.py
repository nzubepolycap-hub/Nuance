"""Tests for the ChainUnavailableError guard added 2026-09-11 —
services/consensus.py's off-chain LLM mock must never silently judge an
item that already has a real on-chain presence.

Covers all four off-chain write endpoints that can reach run_consensus
(or, for place_bet, mirror a notional stake) and confirms each:
  1. Rejects 503, before creating any row, when the item is already
     linked to a deployed contract / filed on-chain.
  2. Still works normally (the legacy/unlinked path is unaffected) when
     the item has no on-chain presence at all — this is the actual thing
     the guard must NOT break.

  - POST /escrows/{id}/deliverable       (routers/escrows.py)
  - POST /escrows/{id}/dispute           (routers/escrows.py)
  - POST /disputes/{id}/evidence         (routers/disputes.py)
  - POST /predictions/{id}/bet           (routers/predictions.py)

Also confirms resolve_prediction's pre-existing linked-market guard was
upgraded from a plain 400 to the same 503/ChainUnavailableError shape —
see test_prediction_on_chain_endpoints.py's own
test_resolve_prediction_rejects_on_chain_linked_market for that one.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal

_TMP_DIR = tempfile.mkdtemp(prefix="nuance-chain-unavailable-test-")
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_TMP_DIR}/test.db")
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-pytest-only-32bytes+")

from eth_account import Account  # noqa: E402
from eth_account.messages import encode_defunct  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import AsyncSessionLocal  # noqa: E402
from app.enums import StatusKey  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Dispute, Escrow, Milestone, Prediction, User  # noqa: E402

_BOOTSTRAP_CONTRACT_ADDRESS = "0xDB6939bD12775e5F77e48138F0DE103D804268f7"
_FAKE_TX_HASH = "0x" + "22" * 32


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


async def _create_escrow(creator: str, counterparty: str, contract_address: str | None) -> int:
    async with AsyncSessionLocal() as db:
        for addr in (creator, counterparty):
            if await db.get(User, addr) is None:
                db.add(User(wallet_address=addr))
        escrow = Escrow(
            creator_address=creator,
            counterparty_address=counterparty,
            title="Chain-unavailable guard test escrow",
            total=Decimal("2.50"),
            status_key=StatusKey.IN_PROGRESS,
            contract_address=contract_address,
        )
        escrow.milestones.append(
            Milestone(
                name="Milestone 1",
                amount=Decimal("2.50"),
                status_key=StatusKey.PENDING,
                criteria="Looks good.",
                order_index=0,
            )
        )
        db.add(escrow)
        await db.commit()
        await db.refresh(escrow)
        return escrow.id


async def _create_dispute(escrow_id: int, opened_by: str, on_chain_tx_hash: str | None) -> int:
    async with AsyncSessionLocal() as db:
        dispute = Dispute(
            escrow_id=escrow_id,
            opened_by_address=opened_by,
            issue="Deliverable doesn't match the brief.",
            status_key=StatusKey.DISPUTED,
            on_chain_tx_hash=on_chain_tx_hash,
        )
        db.add(dispute)
        await db.commit()
        await db.refresh(dispute)
        return dispute.id


async def _create_prediction(contract_address: str | None) -> int:
    async with AsyncSessionLocal() as db:
        prediction = Prediction(
            title="Will this guard hold?",
            description="Test market for the chain-unavailable guard.",
            category="Test",
            status_key="open",
            resolution_date=datetime.now(timezone.utc) + timedelta(days=1),
            contract_address=contract_address,
        )
        db.add(prediction)
        await db.commit()
        await db.refresh(prediction)
        return prediction.id


# --- submit_deliverable (POST /escrows/{id}/deliverable) -------------------


def test_submit_deliverable_rejects_linked_escrow(client: TestClient):
    creator = Account.create()
    counterparty = Account.create()
    _get_token(client, creator)
    token = _get_token(client, counterparty)
    escrow_id = asyncio.run(
        _create_escrow(creator.address.lower(), counterparty.address.lower(), _BOOTSTRAP_CONTRACT_ADDRESS)
    )

    resp = client.post(
        f"/escrows/{escrow_id}/deliverable",
        json={"text": "Here's the work."},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 503
    assert "deliverable/on-chain" in resp.json()["detail"]


def test_submit_deliverable_allows_unlinked_escrow(client: TestClient):
    creator = Account.create()
    counterparty = Account.create()
    _get_token(client, creator)
    token = _get_token(client, counterparty)
    escrow_id = asyncio.run(
        _create_escrow(creator.address.lower(), counterparty.address.lower(), None)
    )

    resp = client.post(
        f"/escrows/{escrow_id}/deliverable",
        json={"text": "Here's the work."},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, resp.text


# --- raise_dispute (POST /escrows/{id}/dispute) -----------------------------


def test_raise_dispute_rejects_linked_escrow(client: TestClient):
    creator = Account.create()
    counterparty = Account.create()
    token = _get_token(client, creator)
    _get_token(client, counterparty)
    escrow_id = asyncio.run(
        _create_escrow(creator.address.lower(), counterparty.address.lower(), _BOOTSTRAP_CONTRACT_ADDRESS)
    )

    resp = client.post(
        f"/escrows/{escrow_id}/dispute",
        json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 503
    assert "dispute/on-chain" in resp.json()["detail"]


def test_raise_dispute_allows_unlinked_escrow(client: TestClient):
    creator = Account.create()
    counterparty = Account.create()
    token = _get_token(client, creator)
    _get_token(client, counterparty)
    escrow_id = asyncio.run(
        _create_escrow(creator.address.lower(), counterparty.address.lower(), None)
    )

    resp = client.post(
        f"/escrows/{escrow_id}/dispute",
        json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, resp.text


# --- submit_evidence (POST /disputes/{id}/evidence) -------------------------


def test_submit_evidence_rejects_on_chain_filed_dispute(client: TestClient):
    creator = Account.create()
    counterparty = Account.create()
    token = _get_token(client, creator)
    _get_token(client, counterparty)
    escrow_id = asyncio.run(
        _create_escrow(creator.address.lower(), counterparty.address.lower(), _BOOTSTRAP_CONTRACT_ADDRESS)
    )
    dispute_id = asyncio.run(
        _create_dispute(escrow_id, creator.address.lower(), _FAKE_TX_HASH)
    )

    resp = client.post(
        f"/disputes/{dispute_id}/evidence",
        json={"description": "Here's my proof."},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 503
    assert "evidence/on-chain" in resp.json()["detail"]


def test_submit_evidence_allows_off_chain_dispute(client: TestClient):
    creator = Account.create()
    counterparty = Account.create()
    token = _get_token(client, creator)
    _get_token(client, counterparty)
    escrow_id = asyncio.run(
        _create_escrow(creator.address.lower(), counterparty.address.lower(), None)
    )
    dispute_id = asyncio.run(
        _create_dispute(escrow_id, creator.address.lower(), None)
    )

    resp = client.post(
        f"/disputes/{dispute_id}/evidence",
        json={"description": "Here's my proof."},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, resp.text


# --- place_bet (POST /predictions/{id}/bet) ---------------------------------


def test_place_bet_rejects_linked_market(client: TestClient):
    wallet = Account.create()
    token = _get_token(client, wallet)
    prediction_id = asyncio.run(_create_prediction(_BOOTSTRAP_CONTRACT_ADDRESS))

    resp = client.post(
        f"/predictions/{prediction_id}/bet",
        json={"side": "YES", "amount": 500},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 503
    assert "bet/on-chain" in resp.json()["detail"]


def test_place_bet_allows_unlinked_market(client: TestClient):
    wallet = Account.create()
    token = _get_token(client, wallet)
    prediction_id = asyncio.run(_create_prediction(None))

    resp = client.post(
        f"/predictions/{prediction_id}/bet",
        json={"side": "YES", "amount": 500},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, resp.text
