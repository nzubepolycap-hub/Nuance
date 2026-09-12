"""Tests for POST /predictions — the 2026-09-12 rebrand's real
Create-Market form, replacing services/market_generator.py's tweet-
scraping pipeline as the actual way new markets get made. No LLM
involved: a person writes the question/criteria/source URL directly.

Covers:
  1. Happy path: creates the market status_key="pending_review" (hidden/
     unbettable — see routers/predictions.py's create_prediction and
     list_predictions' own default filter), with no contract_address yet
     (deploy is a background task, mocked out here — no real network).
  2. Requires authentication.
  3. title must be phrased as a question (end in "?").
  4. resolution_source_url must be http(s) — on-chain-only markets have
     nothing to fetch/judge against without one.
  5. resolution_date must be in the future.
  6. A freshly created market does NOT show up in the default (open-only)
     GET /predictions listing — it's genuinely hidden until deployed.
"""

from __future__ import annotations

import os
import tempfile
from datetime import datetime, timedelta, timezone

_TMP_DIR = tempfile.mkdtemp(prefix="nuance-create-prediction-test-")
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_TMP_DIR}/test.db")
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-pytest-only-32bytes+")

from eth_account import Account  # noqa: E402
from eth_account.messages import encode_defunct  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture
def client():
    # No mocking needed here, deliberately — create_prediction's deploy
    # trigger is gated on settings.auto_deploy_prediction_contracts (see
    # that endpoint's own docstring for exactly why: a monkeypatch aimed
    # at the wrong binding once let a REAL Bradbury deploy slip through
    # this exact test file). conftest.py's autouse
    # _disable_prediction_auto_deploy_by_default fixture already forces
    # that flag off for every test in the suite, so the background task
    # is never even queued here — no per-file mock to get wrong.
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


def _valid_payload(**overrides) -> dict:
    payload = {
        "title": "Will GenLayer ship testnet v2 by end of Q4 2026?",
        "description": "Resolves YES if genlayer.com's official blog announces testnet v2 has "
        "launched before 2027-01-01. Resolves NO otherwise.",
        "category": "GenLayer Ecosystem",
        "resolution_date": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
        "resolution_source_url": "https://genlayer.com/blog",
    }
    payload.update(overrides)
    return payload


def test_create_prediction_happy_path(client: TestClient):
    wallet = Account.create()
    token = _get_token(client, wallet)

    resp = client.post(
        "/predictions", json=_valid_payload(), headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status_key"] == "pending_review"
    assert body["contract_address"] is None
    assert body["title"].endswith("?")


def test_create_prediction_requires_auth(client: TestClient):
    resp = client.post("/predictions", json=_valid_payload())
    assert resp.status_code in (401, 403)


def test_create_prediction_rejects_non_question_title(client: TestClient):
    wallet = Account.create()
    token = _get_token(client, wallet)

    resp = client.post(
        "/predictions",
        json=_valid_payload(title="GenLayer will ship testnet v2 by end of Q4 2026"),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_create_prediction_rejects_bad_resolution_url(client: TestClient):
    wallet = Account.create()
    token = _get_token(client, wallet)

    resp = client.post(
        "/predictions",
        json=_valid_payload(resolution_source_url="not-a-url"),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_create_prediction_rejects_past_resolution_date(client: TestClient):
    wallet = Account.create()
    token = _get_token(client, wallet)

    resp = client.post(
        "/predictions",
        json=_valid_payload(
            resolution_date=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        ),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 422


def test_created_market_hidden_from_default_listing(client: TestClient):
    wallet = Account.create()
    token = _get_token(client, wallet)

    create_resp = client.post(
        "/predictions", json=_valid_payload(), headers={"Authorization": f"Bearer {token}"}
    )
    prediction_id = create_resp.json()["id"]

    default_listing = client.get("/predictions").json()
    assert prediction_id not in {p["id"] for p in default_listing}

    all_listing = client.get("/predictions", params={"status": "all"}).json()
    assert prediction_id in {p["id"] for p in all_listing}
