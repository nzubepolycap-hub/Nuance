"""Prediction markets router — GET /predictions, GET /predictions/{id}, POST /predictions/{id}/bet.

Row locking (ROADMAP.md Part 3 5.4): `place_bet`/`place_bet_on_chain` read
`status_key`/`resolution_date` then write a new position + `volume` —
without a lock, a bet can land concurrently with `resolve_prediction_
market` (services/prediction_oracle.py) acting on stale "still open"
state, landing a bet the resolution decision never accounted for.
`_get_prediction_for_update_or_404`'s `SELECT ... FOR UPDATE` closes this
the same way routers/escrows.py/disputes.py/governance.py's equivalents
do — prediction_oracle.py's own fetch inside resolve_prediction_market
takes the same lock on its side, so the two paths actually serialize
against each other despite living in different modules/sessions (a
Postgres row lock doesn't care which code acquired it, only that it's the
same row). A no-op on SQLite, a real lock on Postgres.

Both write endpoints also share `_assert_market_open_for_betting` — a bet
must land on a market that's still open and before its own deadline,
on-chain or off (see that function's own docstring for the real bug this
closed on the on-chain path specifically).
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_db
from app.dependencies import get_current_user, require_user_with_scope
from app.models import Prediction, PredictionPosition, User
from app.schemas import OnChainBetAck, PredictionBetCreate, PredictionPositionRead, PredictionRead

router = APIRouter(prefix="/predictions", tags=["predictions"])


async def _get_prediction_or_404(prediction_id: int, db: AsyncSession) -> Prediction:
    result = await db.execute(
        select(Prediction)
        .where(Prediction.id == prediction_id)
        .options(selectinload(Prediction.positions))
    )
    prediction = result.scalar_one_or_none()
    if prediction is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Prediction market not found."
        )
    return prediction


async def _get_prediction_for_update_or_404(prediction_id: int, db: AsyncSession) -> Prediction:
    """Same as _get_prediction_or_404, but holds a row lock for the rest
    of this transaction — use for place_bet/place_bet_on_chain
    specifically (see module docstring). Never use for a plain read
    (list_predictions/get_prediction) — locking rows a GET request has no
    intention of writing to would only add contention.
    """
    result = await db.execute(
        select(Prediction)
        .where(Prediction.id == prediction_id)
        .options(selectinload(Prediction.positions))
        .with_for_update()
    )
    prediction = result.scalar_one_or_none()
    if prediction is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Prediction market not found."
        )
    return prediction


def _resolution_date_utc(prediction: Prediction) -> datetime:
    """`Prediction.resolution_date` round-trips as naive on SQLite —
    normalize to UTC-aware before comparing against `datetime.now(utc)`.
    Shared by place_bet/place_bet_on_chain/resolve_prediction, which
    each used to inline this same three-line snippet independently."""
    return (
        prediction.resolution_date
        if prediction.resolution_date.tzinfo is not None
        else prediction.resolution_date.replace(tzinfo=timezone.utc)
    )


def _assert_market_open_for_betting(prediction: Prediction) -> None:
    """Shared by place_bet and place_bet_on_chain — a bet, on-chain or
    off, must land on a market that's still actually open and before its
    own cutoff. Found missing from place_bet_on_chain during a security
    review (2026-09-09): that endpoint accepted a bet on any on-chain-
    linked market regardless of status/deadline, letting a fabricated
    position skew services/payout.py::calculate_prediction_payouts'
    pari-mutuel math for every other real bettor once the market
    resolved. See ROADMAP.md/RUNBOOK.md for the full account."""
    if prediction.status_key.lower() != "open":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Prediction market is not open for betting.",
        )
    if datetime.now(timezone.utc) >= _resolution_date_utc(prediction):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Betting has closed for this market",
        )


@router.get("", response_model=list[PredictionRead])
async def list_predictions(
    status: str | None = "open",
    db: AsyncSession = Depends(get_db),
) -> list[Prediction]:
    """Defaults to only `status_key == "open"` markets so unreviewed drafts
    (`"pending_review"`, see services/market_generator.py) never leak into
    the public betting feed just because a caller forgot to filter.

    `status=None` or `status="all"` (case-insensitive) returns every market
    regardless of status — e.g. for an internal review queue. Any other
    value filters to that exact status, matched case-insensitively since
    status_key casing isn't consistent across the codebase today (markets
    are created as lowercase "open"/"pending_review", but
    services/prediction_oracle.py resolves them to uppercase "RESOLVED").
    """
    query = select(Prediction).options(selectinload(Prediction.positions)).order_by(Prediction.id.asc())
    if status is not None and status.strip().lower() != "all":
        query = query.where(func.lower(Prediction.status_key) == status.strip().lower())
    result = await db.execute(query)
    return list(result.scalars().all())


@router.get("/{prediction_id}", response_model=PredictionRead)
async def get_prediction(
    prediction_id: int, db: AsyncSession = Depends(get_db)
) -> Prediction:
    return await _get_prediction_or_404(prediction_id, db)


@router.post(
    "/{prediction_id}/bet",
    response_model=PredictionRead,
    status_code=status.HTTP_201_CREATED,
)
async def place_bet(
    prediction_id: int,
    payload: PredictionBetCreate,
    db: AsyncSession = Depends(get_db),
    # ROADMAP.md Part 4 6.1 — see routers/escrows.py::create_escrow's own
    # note on require_user_with_scope.
    current_user: User = Depends(require_user_with_scope("bet:place")),
) -> Prediction:
    prediction = await _get_prediction_for_update_or_404(prediction_id, db)
    _assert_market_open_for_betting(prediction)

    position = PredictionPosition(
        prediction_id=prediction.id,
        wallet_address=current_user.wallet_address,
        side=payload.side,
        amount=payload.amount,
    )
    prediction.volume = (prediction.volume or 0) + payload.amount

    db.add(position)
    await db.commit()
    db.expire_all()
    return await _get_prediction_or_404(prediction_id, db)


@router.post(
    "/{prediction_id}/bet/on-chain",
    response_model=PredictionRead,
    status_code=status.HTTP_201_CREATED,
)
async def place_bet_on_chain(
    prediction_id: int,
    payload: OnChainBetAck,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Prediction:
    """The on-chain counterpart to place_bet above — reached once
    components/app/genlayer-write-client.ts's betOnChain has already
    signed and sent a real NuancePredictionMarket.bet transaction directly
    to the chain. Doesn't verify the hash is real (see
    OnChainSubmissionAck's own docstring on why that's fine — nothing here
    is a trust boundary for the market's actual outcome); this only
    mirrors the stake into a PredictionPosition row so the existing "my
    positions" UI keeps working, since services/genlayer_indexer.py's
    view-sync doesn't track individual bettors' on-chain stakes today,
    only the market's own state/outcome as a whole.

    FIXED 2026-09-10 — this used to skip the same open/deadline check
    place_bet enforces, and read via the non-locking _get_prediction_
    or_404: any signed-in wallet could mirror a fabricated position onto
    a closed/resolved/past-deadline market (no real tx_hash verification
    either way — see above), which then skewed services/payout.py's
    pari-mutuel payout math for every other real bettor once the market
    resolved. Now takes the same lock and the same guard as place_bet;
    only the tx-hash-isn't-verified property (intentional, per this
    docstring's own first paragraph) remains different between the two.
    """
    prediction = await _get_prediction_for_update_or_404(prediction_id, db)
    if prediction.contract_address is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This market isn't linked to a deployed contract — use the "
            "off-chain POST /predictions/{id}/bet instead.",
        )
    _assert_market_open_for_betting(prediction)

    position = PredictionPosition(
        prediction_id=prediction.id,
        wallet_address=current_user.wallet_address,
        side=payload.side,
        amount=payload.amount,
    )
    prediction.volume = (prediction.volume or 0) + payload.amount

    db.add(position)
    await db.commit()
    db.expire_all()
    return await _get_prediction_or_404(prediction_id, db)


@router.post(
    "/{prediction_id}/resolve",
    response_model=PredictionRead,
)
async def resolve_prediction(
    prediction_id: int,
    db: AsyncSession = Depends(get_db),
) -> Prediction:
    prediction = await _get_prediction_or_404(prediction_id, db)

    if prediction.contract_address is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This market is linked to a deployed contract — it resolves on-chain "
            "automatically (services/genlayer_indexer.py's "
            "trigger_pending_market_resolutions) once its cutoff passes, not through "
            "this off-chain endpoint.",
        )

    if datetime.now(timezone.utc) < _resolution_date_utc(prediction):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Market cannot be resolved before its resolution date: {prediction.resolution_date.isoformat()}",
        )

    from app.services.prediction_oracle import OracleUnavailableError, resolve_prediction_market

    try:
        return await resolve_prediction_market(prediction_id, db)
    except OracleUnavailableError as exc:
        # Distinct from the ValueError->404 mapping below: the market
        # itself is fine (found, past its resolution date) — the oracle
        # just isn't reachable right now (e.g. no GEMINI_API_KEY
        # configured). See that exception's own docstring for why this
        # must never fall back to fabricating a resolution instead.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        )




