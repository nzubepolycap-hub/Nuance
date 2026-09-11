"""Tests for GET /analytics/overview (ROADMAP.md Part 3 5.5).

Seeds real rows directly (bypassing the API where that's simpler) and
checks the actual arithmetic each aggregate is supposed to produce — not
just that the endpoint returns 200.

Delta-based, not absolute-value — found live while adding test_agent_
history.py: every test file in this suite sets `DATABASE_URL` via
`os.environ.setdefault` at import time, but `app/db.py`'s engine (and
`app/config.py`'s `get_settings()`) are constructed ONCE, at first
import, and `lru_cache`d — so whichever test module pytest happens to
collect first "wins" that env var race, and every other file's own
`setdefault` is a no-op. In practice this means the whole `pytest -q`
run shares ONE SQLite file across every test module, not an isolated db
per file as each file's own `_TMP_DIR` comment implies. Most tests never
notice (they scope assertions to specific wallet addresses/rows they
just created), but this file's original version asserted *global* sums
("TVL across every escrow") and true emptiness — both broke the moment
a same-session file sorting earlier alphabetically (test_agent_
history.py) started seeding its own escrows. Fixed here by asserting
deltas (before -> after this file's own seed) instead of absolutes,
which holds regardless of what any other file already left behind or
adds later. This is a real, pre-existing gap in the suite's isolation,
not a full fix for it — flagged, not silently worked around.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal

_TMP_DIR = tempfile.mkdtemp(prefix="nuance-analytics-test-")
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{_TMP_DIR}/test.db")
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-pytest-only-32bytes+")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import AsyncSessionLocal  # noqa: E402
from app.enums import StatusKey  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Dispute, Escrow, Milestone, Prediction, User  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def _init_schema():
    with TestClient(app):
        yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


async def _seed() -> None:
    async with AsyncSessionLocal() as db:
        for addr in ("0xaaaa000000000000000000000000000000aaaa", "0xbbbb000000000000000000000000000000bbbb"):
            if await db.get(User, addr) is None:
                db.add(User(wallet_address=addr))

        # Escrow 1: open, one milestone released (paid out, doesn't count
        # toward TVL), one still locked (does count).
        escrow1 = Escrow(
            creator_address="0xaaaa000000000000000000000000000000aaaa",
            counterparty_address="0xbbbb000000000000000000000000000000bbbb",
            title="Escrow 1",
            total=Decimal("300.00"),
            status_key=StatusKey.IN_PROGRESS,
        )
        escrow1.milestones.append(
            Milestone(
                name="Paid",
                amount=Decimal("100.00"),
                status_key=StatusKey.APPROVED,
                criteria="x",
                order_index=0,
                released_at=datetime.now(timezone.utc),
            )
        )
        escrow1.milestones.append(
            Milestone(
                name="Locked", amount=Decimal("200.00"), status_key=StatusKey.PENDING, criteria="x", order_index=1
            )
        )
        db.add(escrow1)

        # Escrow 2: cancelled — its still-unreleased milestone must NOT
        # count toward TVL (the funds were refunded, see cancel_escrow).
        escrow2 = Escrow(
            creator_address="0xaaaa000000000000000000000000000000aaaa",
            counterparty_address="0xbbbb000000000000000000000000000000bbbb",
            title="Escrow 2 (cancelled)",
            total=Decimal("500.00"),
            status_key=StatusKey.CANCELLED,
        )
        escrow2.milestones.append(
            Milestone(
                name="Refunded", amount=Decimal("500.00"), status_key=StatusKey.PENDING, criteria="x", order_index=0
            )
        )
        db.add(escrow2)

        # Escrow 3: open, unreleased milestone — but denominated in the
        # seeded testnet USDC (asset_id=2, not native GEN, id=1). Must
        # NOT count toward tvl_open_escrows_gen — regression coverage for
        # a real bug found 2026-09-10 (integration audit): this endpoint
        # used to sum every escrow's milestones regardless of asset,
        # silently blending non-GEN amounts into a field named "_gen".
        escrow3 = Escrow(
            creator_address="0xaaaa000000000000000000000000000000aaaa",
            counterparty_address="0xbbbb000000000000000000000000000000bbbb",
            title="Escrow 3 (USDC)",
            total=Decimal("9000.00"),
            asset_id=2,
            status_key=StatusKey.IN_PROGRESS,
        )
        escrow3.milestones.append(
            Milestone(
                name="Locked (USDC)",
                amount=Decimal("9000.00"),
                status_key=StatusKey.PENDING,
                criteria="x",
                order_index=0,
            )
        )
        db.add(escrow3)

        await db.flush()

        # Two resolved disputes, 2h and 6h resolution times.
        now = datetime.now(timezone.utc)
        db.add(
            Dispute(
                escrow_id=escrow1.id,
                opened_by_address="0xaaaa000000000000000000000000000000aaaa",
                issue="Dispute A",
                created_at=now - timedelta(hours=2),
                resolved_at=now,
            )
        )
        db.add(
            Dispute(
                escrow_id=escrow1.id,
                opened_by_address="0xaaaa000000000000000000000000000000aaaa",
                issue="Dispute B",
                created_at=now - timedelta(hours=6),
                resolved_at=now,
            )
        )
        # An unresolved dispute must not be counted at all.
        db.add(
            Dispute(
                escrow_id=escrow1.id,
                opened_by_address="0xaaaa000000000000000000000000000000aaaa",
                issue="Still open",
            )
        )

        db.add(
            Prediction(
                title="Will it rain?",
                description="x",
                category="weather",
                resolution_date=now + timedelta(days=1),
                volume=1500,  # 1.5 GEN in milli-GEN
                status_key="open",
            )
        )
        db.add(
            Prediction(
                title="Election outcome",
                description="x",
                category="politics",
                resolution_date=now + timedelta(days=1),
                volume=2500,  # 2.5 GEN
                status_key="open",
            )
        )

        await db.commit()


def test_analytics_overview_math(client):
    before = client.get("/analytics/overview").json()

    asyncio.run(_seed())

    after = client.get("/analytics/overview").json()

    # TVL: escrow1's unreleased 200.00 milestone only — the paid-out 100,
    # the cancelled escrow's refunded 500, and escrow3's 9000.00 USDC
    # (denominated in a non-native asset — see _tvl_open_escrows' own
    # docstring) are all excluded.
    tvl_delta = Decimal(after["tvl_open_escrows_gen"]) - Decimal(before["tvl_open_escrows_gen"])
    assert tvl_delta == Decimal("200.00")
    assert after["open_escrow_count"] - before["open_escrow_count"] == 1

    assert after["resolved_dispute_count"] - before["resolved_dispute_count"] == 2

    volume_delta = Decimal(after["prediction_market_volume_gen"]) - Decimal(before["prediction_market_volume_gen"])
    assert volume_delta == Decimal("4")
    assert after["prediction_market_count"] - before["prediction_market_count"] == 2

    assert isinstance(after["validator_leaderboard"], list)
    assert "generated_at" in after

    # dispute_resolution_median_hours is a *global* median, not
    # attributable to just this seed if other tests in this shared db
    # also resolved disputes — a real value (not None, now that at least
    # 2 resolved disputes definitely exist) is the meaningful, order-
    # independent assertion here.
    assert after["dispute_resolution_median_hours"] is not None
    assert after["resolved_dispute_count"] >= 2
