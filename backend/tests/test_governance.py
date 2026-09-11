"""Tests for Governance — GET/POST /proposals, vote (incl. re-vote flip),
finalize, plus the /validators and /agents directories.

Like test_predictions.py, this runs against the real configured database
(AsyncSessionLocal), not an isolated per-test one — so `_total_eligible_
voters()` (every User row ever created) is a *global*, ever-growing count
in this suite. Finalize tests account for that by pinning `quorum_threshold`
to 0 (always met) or an unreachable 1000 (never met) when they need a
deterministic quorum outcome, rather than asserting on the live turnout
percentage itself.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient

from app.db import AsyncSessionLocal
from app.enums import ProposalStatus, VoteChoice
from app.main import app
from app.models import Proposal, Vote


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def wallet():
    return Account.create()


def _get_token(client: TestClient, wallet: Account) -> str:
    message = client.post("/auth/nonce", json={"wallet_address": wallet.address}).json()["message"]
    signature = wallet.sign_message(encode_defunct(text=message)).signature.hex()
    resp = client.post(
        "/auth/verify",
        json={"wallet_address": wallet.address, "message": message, "signature": signature},
    )
    assert resp.status_code == 200
    return resp.json()["access_token"]


def _auth_headers(client: TestClient, wallet: Account) -> dict:
    return {"Authorization": f"Bearer {_get_token(client, wallet)}"}


async def _seed_proposal(
    *,
    status: ProposalStatus = ProposalStatus.ACTIVE,
    end_delta_days: int = 7,
    quorum_threshold: int = 20,
    pass_threshold: int = 50,
    total_for: int = 0,
    total_against: int = 0,
    total_abstain: int = 0,
) -> int:
    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as db:
        proposer = Account.create()
        from app.models import User

        db.add(User(wallet_address=proposer.address.lower()))
        await db.flush()

        proposal = Proposal(
            title="Seeded proposal",
            description="For finalize/quorum tests.",
            proposer_address=proposer.address.lower(),
            status=status,
            start_time=now - timedelta(days=1),
            end_time=now + timedelta(days=end_delta_days),
            quorum_threshold=quorum_threshold,
            pass_threshold=pass_threshold,
            total_for=total_for,
            total_against=total_against,
            total_abstain=total_abstain,
        )
        db.add(proposal)
        await db.commit()
        await db.refresh(proposal)
        return proposal.id


# --- list / create -----------------------------------------------------


def test_list_proposals_ok(client):
    resp = client.get("/proposals")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_create_proposal_requires_auth(client):
    resp = client.post(
        "/proposals", json={"title": "Unauthed proposal", "description": "Should 401."}
    )
    assert resp.status_code == 401


def test_create_proposal_success(client, wallet):
    headers = _auth_headers(client, wallet)
    resp = client.post(
        "/proposals",
        json={
            "title": "Fund a public GenVM debugging toolkit",
            "description": "Allocate treasury funds toward open-source tooling.",
            "category": "Treasury",
            "voting_period_days": 5,
            "quorum_threshold": 20,
            "pass_threshold": 50,
        },
        headers=headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "active"
    assert body["proposer_address"] == wallet.address.lower()
    assert body["total_for"] == body["total_against"] == body["total_abstain"] == 0
    assert body["quorum_met"] is False
    assert body["user_vote"] is None


# --- voting + re-vote ----------------------------------------------------


@pytest.mark.asyncio
async def test_vote_then_revote_flips_not_stacks(client, wallet):
    proposal_id = await _seed_proposal()
    headers = _auth_headers(client, wallet)

    resp = client.post(f"/proposals/{proposal_id}/vote", json={"choice": "for"}, headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_for"] == 1
    assert body["user_vote"] == "for"

    # Flip to AGAINST (also exercises case-insensitive input).
    resp = client.post(f"/proposals/{proposal_id}/vote", json={"choice": "AGAINST"}, headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_for"] == 0, "flipping away from FOR must remove the old tally"
    assert body["total_against"] == 1
    assert body["user_vote"] == "against"

    # Exactly one Vote row for this wallet on this proposal, not two.
    detail = client.get(f"/proposals/{proposal_id}").json()
    votes_for_wallet = [v for v in detail["votes"] if v["voter_address"] == wallet.address.lower()]
    assert len(votes_for_wallet) == 1
    assert votes_for_wallet[0]["choice"] == "against"


def test_vote_invalid_choice_rejected(client, wallet):
    headers = _auth_headers(client, wallet)
    resp = client.post("/proposals/1/vote", json={"choice": "maybe"}, headers=headers)
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_vote_on_non_active_proposal_rejected(client, wallet):
    proposal_id = await _seed_proposal(status=ProposalStatus.REJECTED)
    headers = _auth_headers(client, wallet)
    resp = client.post(f"/proposals/{proposal_id}/vote", json={"choice": "for"}, headers=headers)
    assert resp.status_code == 400
    assert "closed" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_vote_after_end_time_rejected(client, wallet):
    proposal_id = await _seed_proposal(end_delta_days=-1)
    headers = _auth_headers(client, wallet)
    resp = client.post(f"/proposals/{proposal_id}/vote", json={"choice": "for"}, headers=headers)
    assert resp.status_code == 400
    assert "ended" in resp.json()["detail"].lower()


# --- finalize --------------------------------------------------------------


def test_finalize_too_early_rejected(client, wallet):
    headers = _auth_headers(client, wallet)
    created = client.post(
        "/proposals",
        json={"title": "Too soon", "description": "x", "voting_period_days": 7},
        headers=headers,
    ).json()
    resp = client.post(f"/proposals/{created['id']}/finalize")
    assert resp.status_code == 400
    assert "still open" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_finalize_passes_when_quorum_met_and_for_majority(client):
    proposal_id = await _seed_proposal(
        end_delta_days=-1,
        quorum_threshold=0,  # always met, regardless of this DB's total user count
        pass_threshold=50,
        total_for=3,
        total_against=1,
    )
    resp = client.post(f"/proposals/{proposal_id}/finalize")
    assert resp.status_code == 200
    assert resp.json()["status"] == "passed"


@pytest.mark.asyncio
async def test_finalize_rejects_when_quorum_not_met(client):
    # Zero turnout against any positive threshold is unreachable no matter
    # how many total users this shared DB already has — unlike pinning a
    # raw vote count against a "high" threshold, which isn't actually safe
    # here: total_for/against/abstain are seeded directly, disconnected
    # from real distinct voters, so an arbitrarily large seeded count can
    # legitimately exceed 100% turnout against this suite's (small, but
    # not fixed) real eligible-voter count.
    proposal_id = await _seed_proposal(end_delta_days=-1, quorum_threshold=1, total_for=0)
    resp = client.post(f"/proposals/{proposal_id}/finalize")
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"


@pytest.mark.asyncio
async def test_finalize_rejects_when_against_majority(client):
    proposal_id = await _seed_proposal(
        end_delta_days=-1, quorum_threshold=0, total_for=1, total_against=3
    )
    resp = client.post(f"/proposals/{proposal_id}/finalize")
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"


@pytest.mark.asyncio
async def test_finalize_is_idempotent(client):
    proposal_id = await _seed_proposal(end_delta_days=-1, quorum_threshold=0, total_for=1)
    first = client.post(f"/proposals/{proposal_id}/finalize")
    second = client.post(f"/proposals/{proposal_id}/finalize")
    assert first.status_code == second.status_code == 200
    assert first.json()["status"] == second.json()["status"] == "passed"


# --- lazy auto-finalize (list/get) ------------------------------------------
#
# Regression coverage for a real integration gap found 2026-09-10: nothing
# in this app, frontend or backend, ever called POST /proposals/{id}/
# finalize automatically — no cron, no UI button — so a proposal stayed
# ACTIVE forever once its own end_time passed, even though finalize_
# proposal's own docstring had anticipated "a future bulk sweep" that was
# never built. Fixed by having list_proposals/get_proposal opportunistically
# finalize any past-due ACTIVE proposal as a side effect of the read
# (_finalize_if_due) — these tests prove that actually happens without ever
# calling the explicit /finalize endpoint themselves.


@pytest.mark.asyncio
async def test_get_proposal_lazily_finalizes_a_past_due_active_proposal(client):
    proposal_id = await _seed_proposal(
        end_delta_days=-1, quorum_threshold=0, pass_threshold=50, total_for=3, total_against=1
    )
    resp = client.get(f"/proposals/{proposal_id}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "passed"


@pytest.mark.asyncio
async def test_list_proposals_lazily_finalizes_a_past_due_active_proposal(client):
    proposal_id = await _seed_proposal(end_delta_days=-1, quorum_threshold=1, total_for=0)
    resp = client.get("/proposals")
    assert resp.status_code == 200
    by_id = {p["id"]: p for p in resp.json()}
    assert by_id[proposal_id]["status"] == "rejected"


@pytest.mark.asyncio
async def test_list_proposals_does_not_touch_a_still_open_proposal(client):
    proposal_id = await _seed_proposal(end_delta_days=7)
    resp = client.get("/proposals")
    assert resp.status_code == 200
    by_id = {p["id"]: p for p in resp.json()}
    assert by_id[proposal_id]["status"] == "active"


# --- execute ---------------------------------------------------------------


def test_execute_requires_auth(client):
    resp = client.post("/proposals/1/execute")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_execute_rejects_non_passed_proposal(client, wallet):
    proposal_id = await _seed_proposal(status=ProposalStatus.ACTIVE)
    resp = client.post(f"/proposals/{proposal_id}/execute", headers=_auth_headers(client, wallet))
    assert resp.status_code == 400
    assert "passed" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_execute_success_on_passed_proposal(client, wallet):
    proposal_id = await _seed_proposal(status=ProposalStatus.PASSED)
    resp = client.post(f"/proposals/{proposal_id}/execute", headers=_auth_headers(client, wallet))
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "executed"
    assert body["executed_by"] == wallet.address.lower()
    assert body["executed_at"] is not None


@pytest.mark.asyncio
async def test_execute_twice_is_rejected_not_idempotent(client, wallet):
    proposal_id = await _seed_proposal(status=ProposalStatus.PASSED)
    headers = _auth_headers(client, wallet)
    first = client.post(f"/proposals/{proposal_id}/execute", headers=headers)
    second = client.post(f"/proposals/{proposal_id}/execute", headers=headers)
    assert first.status_code == 200
    assert second.status_code == 400
    assert "already executed" in second.json()["detail"].lower()


# --- validators / agents directories ---------------------------------------


def test_validators_endpoint_shape(client):
    resp = client.get("/validators")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    for entry in body:
        assert {"name", "cases_judged", "accuracy_pct", "is_active"} <= entry.keys()
        assert 0.0 <= entry["accuracy_pct"] <= 100.0


def test_agents_endpoint_shape(client):
    resp = client.get("/agents")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    for entry in body:
        assert {"wallet_address", "category", "cases_judged", "trust_score"} <= entry.keys()
        assert entry["cases_judged"] > 0, "an agent should never be listed with zero real cases"
