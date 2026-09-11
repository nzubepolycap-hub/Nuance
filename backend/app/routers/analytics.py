"""GET /analytics/overview — backs the frontend's AnalyticsView.

ROADMAP.md Part 3 5.5. Computed live from real rows on every request (same
approach as routers/validators.py and routers/agents.py), not from a
materialized/cached table — 5.5's own second checkbox ("materialized/
aggregated tables refreshed on a cron") is a deliberate scope cut for this
pass, not a silent drop: this endpoint runs a handful of aggregate queries
plus one full scan of ConsensusJob (validators._validator_stats' own cost,
unchanged by this file) per request, which is fine at this app's current
data volume but would want the cron-refreshed table 5.5 describes before
it's under any real load — flagged here rather than guessed away.
"""

from __future__ import annotations

import statistics
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.enums import StatusKey
from app.models import Asset, Dispute, Escrow, Milestone, Prediction
from app.routers.validators import _validator_stats
from app.schemas import AnalyticsOverview

router = APIRouter(prefix="/analytics", tags=["analytics"])

# Position/Prediction.volume is stored in milli-GEN — see schemas/core.py's
# BET_AMOUNTS_MILLI_GEN. Converted to GEN here so every *_gen field in
# AnalyticsOverview shares the same unit.
_MILLI_GEN_PER_GEN = Decimal(1000)


async def _tvl_open_escrows(db: AsyncSession) -> tuple[Decimal, int]:
    """Sum of every not-yet-released milestone's amount, on any escrow that
    isn't cancelled — real value still locked, not just "every escrow that
    exists" (a fully-paid-out escrow has nothing left locked in it, and a
    cancelled one already refunded whatever it held — see contracts/
    nuance_escrow.py's cancel_escrow). `open_escrow_count` is a distinct
    escrow count over that same join, not a milestone count.

    Native-asset (GEN) escrows only — FOUND 2026-09-10 (integration
    audit): this used to sum every escrow's milestones regardless of
    which Asset (ROADMAP.md Part 4 6.2) they're actually denominated in,
    silently blending e.g. testnet USDC amounts into a field this
    response calls `tvl_open_escrows_gen`. A genuinely correct multi-
    asset TVL would need a per-asset breakdown, not a single blended
    number with no fixed unit — out of scope for this fix; this just
    makes sure the existing "_gen" field is never wrong about its own
    unit, the same principle services/genlayer_deploy.py's matching fix
    applies on the deploy side.
    """
    result = await db.execute(
        select(func.coalesce(func.sum(Milestone.amount), 0), func.count(func.distinct(Escrow.id)))
        .select_from(Milestone)
        .join(Escrow, Escrow.id == Milestone.escrow_id)
        .join(Asset, Asset.id == Escrow.asset_id)
        .where(
            Escrow.status_key != StatusKey.CANCELLED,
            Milestone.released_at.is_(None),
            Asset.is_native.is_(True),
        )
    )
    total, count = result.one()
    return Decimal(total), int(count)


async def _dispute_resolution_stats(db: AsyncSession) -> tuple[float | None, int]:
    """Median wall-clock time from a dispute's creation to its
    `resolved_at` (set by either POST /disputes/{id}/enforce or a real
    on-chain adjudicate_dispute verdict landing via services/consensus.py's
    _apply_verdict_to_state — either way is a real resolution). Computed
    in Python via `statistics.median` rather than a DB-side percentile
    function: SQLite has no PERCENTILE_CONT equivalent at all, and this
    endpoint already has to stay portable across both backends (see
    app/db.py's own SQLite/Postgres split) — the row count here is small
    enough that pulling both timestamps and computing the median in-process
    isn't a real cost.
    """
    result = await db.execute(
        select(Dispute.created_at, Dispute.resolved_at).where(Dispute.resolved_at.is_not(None))
    )
    rows = result.all()
    if not rows:
        return None, 0
    hours = [(resolved_at - created_at).total_seconds() / 3600.0 for created_at, resolved_at in rows]
    return round(statistics.median(hours), 2), len(rows)


async def _prediction_market_volume(db: AsyncSession) -> tuple[Decimal, int]:
    result = await db.execute(select(func.coalesce(func.sum(Prediction.volume), 0), func.count(Prediction.id)))
    total_milli_gen, count = result.one()
    return Decimal(total_milli_gen) / _MILLI_GEN_PER_GEN, int(count)


@router.get("/overview", response_model=AnalyticsOverview)
async def get_analytics_overview(db: AsyncSession = Depends(get_db)) -> AnalyticsOverview:
    tvl, open_escrow_count = await _tvl_open_escrows(db)
    median_hours, resolved_count = await _dispute_resolution_stats(db)
    prediction_volume, prediction_count = await _prediction_market_volume(db)
    leaderboard = await _validator_stats(db)

    return AnalyticsOverview(
        tvl_open_escrows_gen=tvl,
        open_escrow_count=open_escrow_count,
        dispute_resolution_median_hours=median_hours,
        resolved_dispute_count=resolved_count,
        prediction_market_volume_gen=prediction_volume,
        prediction_market_count=prediction_count,
        validator_leaderboard=leaderboard,
        generated_at=datetime.now(timezone.utc),
    )
