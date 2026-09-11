"""GET/POST /proposals, POST /proposals/{id}/vote, POST /proposals/{id}/finalize.

Wallet-scoped governance: 1-wallet-1-vote today. `voter_address` on every
`Vote` comes from the verified JWT (`get_current_user`) — the same
nonce -> personal_sign -> JWT flow every other write endpoint in this app
already trusts, not a new verification path.

Voting weight (ROADMAP.md Part 3 5.4's sybil gap): `_voting_power` ties a
wallet's ballot to its account age rather than every wallet flatly
counting 1 — see that function's own docstring. Still a placeholder for
real GEN-stake-weighted voting eventually (ROADMAP.md Part 4), not the
final answer, but a flat weight-of-1 is free to defeat with N disposable
wallets; an age-based floor at least costs an attacker real elapsed time
per wallet, which a stake requirement will later replace outright.

Re-voting rule: `Vote` is unique on `(proposal_id, voter_address)`, so
casting a second vote always updates that row rather than inserting a
duplicate — `_adjust_tally` first backs the old choice's weight out of the
proposal's running totals, then the new choice's weight in, in the same
transaction. This is a deliberate behavior change from the frontend's old
local mock (a flat "+4% nudge, no dedup"): re-voting now flips your prior
vote instead of stacking on top of it. Note re-voting locks in whatever
weight applies *at re-vote time* (a wallet that ages into a higher tier
between votes gets the new, higher weight on its next vote, replacing the
old one in the tally rather than keeping the original) — consistent with
"your current standing determines your current ballot's weight", not a
grandfather clause.

Row locking: every write here that reads a Proposal it's about to mutate
(cast_vote, finalize_proposal, execute_proposal) does so via
`_get_proposal_for_update_or_404`, a `SELECT ... FOR UPDATE` — closes the
concurrent-vote-tally race models/governance.py's own docstring already
flagged ("concurrent votes ... read-modify-write Proposal's tally columns
with no row lock"). A silent no-op on SQLite (confirmed: no error, no
actual locking — SQLite's own effectively-serialized writes cover local
dev/test), a real row lock once this runs on Postgres.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_db
from app.dependencies import get_current_user, get_optional_current_user, require_user_with_scope
from app.enums import ProposalStatus, VoteChoice
from app.models import Proposal, User, Vote
from app.schemas import ProposalCreate, ProposalDetailRead, ProposalRead, VoteCreate, VoteRead

router = APIRouter(prefix="/proposals", tags=["governance"])


def _voting_power(user: User) -> int:
    """Sybil-resistance placeholder (see module docstring): 1 point for
    any signed-in wallet, +1 more for every full `sybil_vote_weight_
    period_days` its account has existed, capped at `sybil_vote_weight_
    max`. A wallet created seconds before casting a vote gets the same
    weight of 1 a flat-DEFAULT_VOTING_POWER scheme always gave everyone —
    the deterrent is that *scaling* a sybil attack (many wallets, each
    voting meaningfully) now costs real elapsed time per wallet, not that
    any single fresh wallet is blocked outright."""
    settings = get_settings()
    created_at = user.created_at
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    age_days = (datetime.now(timezone.utc) - created_at).days
    tiers_earned = age_days // settings.sybil_vote_weight_period_days
    return min(1 + tiers_earned, settings.sybil_vote_weight_max)


async def _get_proposal_or_404(proposal_id: int, db: AsyncSession) -> Proposal:
    proposal = await db.get(Proposal, proposal_id)
    if proposal is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proposal not found.")
    return proposal


async def _get_proposal_for_update_or_404(proposal_id: int, db: AsyncSession) -> Proposal:
    """Same as _get_proposal_or_404, but holds a row lock for the rest of
    this transaction — use for every write that reads-then-mutates a
    Proposal (see module docstring's "Row locking" section). Never use
    for a plain read (list_proposals/get_proposal) — locking rows a GET
    request has no intention of writing to would only add contention.
    """
    result = await db.execute(select(Proposal).where(Proposal.id == proposal_id).with_for_update())
    proposal = result.scalar_one_or_none()
    if proposal is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proposal not found.")
    return proposal


async def _total_eligible_voters(db: AsyncSession) -> int:
    """Turnout's denominator: every wallet that has ever signed in. A rough
    v1 proxy for "eligible voting power" until GEN staking exists — see
    ROADMAP.md Part 1."""
    result = await db.execute(select(func.count()).select_from(User))
    return result.scalar_one()


def _aware(dt: datetime) -> datetime:
    """SQLite round-trips datetimes as naive; treat naive as UTC since
    that's what we always write — same rule security.py's
    nonce_is_expired already applies to nonce timestamps."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _progress(proposal: Proposal, eligible_voters: int) -> dict:
    """Quorum is turnout (however anyone voted) against every wallet that
    could have; pass/fail is FOR's share of *decided* ballots — abstains
    count toward quorum but don't move the pass threshold either way."""
    turnout_power = proposal.total_for + proposal.total_against + proposal.total_abstain
    turnout_pct = (100.0 * turnout_power / eligible_voters) if eligible_voters else 0.0

    decided = proposal.total_for + proposal.total_against
    for_pct = (100.0 * proposal.total_for / decided) if decided else 0.0
    against_pct = (100.0 * proposal.total_against / decided) if decided else 0.0
    abstain_pct = (100.0 * proposal.total_abstain / turnout_power) if turnout_power else 0.0

    return {
        "turnout_pct": round(turnout_pct, 1),
        "for_pct": round(for_pct, 1),
        "against_pct": round(against_pct, 1),
        "abstain_pct": round(abstain_pct, 1),
        "quorum_met": turnout_pct >= proposal.quorum_threshold,
    }


def _finalize_if_due(proposal: Proposal, eligible_voters: int) -> bool:
    """The actual PASSED/REJECTED state transition, shared by the explicit
    POST /proposals/{id}/finalize endpoint below and the lazy auto-
    finalize in list_proposals/get_proposal (added 2026-09-10 — closing a
    real gap found during an integration audit: nothing in this app,
    frontend or backend, ever called finalize_proposal automatically or
    exposed a button for it, so every proposal stayed stuck at ACTIVE
    forever once voting closed, even though this function's own
    docstring already anticipated "a future bulk sweep" that was never
    built). Mutates `proposal` in place and returns whether it changed
    anything; the caller is responsible for committing — a plain GET
    auto-finalizing a stale proposal as a side effect is a deliberate,
    low-risk write (see list_proposals' own comment on why no row lock
    is needed here specifically), not something every caller should
    re-derive.
    """
    if proposal.status != ProposalStatus.ACTIVE:
        return False
    if datetime.now(timezone.utc) < _aware(proposal.end_time):
        return False

    progress = _progress(proposal, eligible_voters)
    passed = progress["quorum_met"] and progress["for_pct"] >= proposal.pass_threshold
    proposal.status = ProposalStatus.PASSED if passed else ProposalStatus.REJECTED
    return True


def _proposal_fields(proposal: Proposal, eligible_voters: int, user_vote: VoteChoice | None) -> dict:
    return {
        "id": proposal.id,
        "title": proposal.title,
        "description": proposal.description,
        "category": proposal.category,
        "proposer_address": proposal.proposer_address,
        "status": proposal.status,
        "start_time": proposal.start_time,
        "end_time": proposal.end_time,
        "quorum_threshold": proposal.quorum_threshold,
        "pass_threshold": proposal.pass_threshold,
        "total_for": proposal.total_for,
        "total_against": proposal.total_against,
        "total_abstain": proposal.total_abstain,
        "executed_by": proposal.executed_by,
        "executed_at": proposal.executed_at,
        "created_at": proposal.created_at,
        "user_vote": user_vote,
        **_progress(proposal, eligible_voters),
    }


def _adjust_tally(proposal: Proposal, choice: VoteChoice, delta: int) -> None:
    if choice == VoteChoice.FOR:
        proposal.total_for += delta
    elif choice == VoteChoice.AGAINST:
        proposal.total_against += delta
    else:
        proposal.total_abstain += delta


@router.get("", response_model=list[ProposalRead])
async def list_proposals(
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_optional_current_user),
) -> list[ProposalRead]:
    result = await db.execute(select(Proposal).order_by(Proposal.created_at.desc()))
    proposals = list(result.scalars().all())
    eligible_voters = await _total_eligible_voters(db)

    # Lazy auto-finalize (see _finalize_if_due's own docstring). No row
    # lock here on purpose — a GET has no business contending with a
    # concurrent voter/finalizer for the row, and a racing double-
    # finalize converges on the same deterministic PASSED/REJECTED value
    # either way (the tally it's computed from doesn't change), unlike
    # vote-casting's read-modify-write, which genuinely needs the lock
    # _get_proposal_for_update_or_404 gives it.
    # A list comprehension, not any(...) directly on the generator — any()
    # short-circuits on the first True, which here would silently skip
    # calling _finalize_if_due (a real mutation, not a pure predicate) on
    # every proposal after the first one due.
    any_finalized = [_finalize_if_due(p, eligible_voters) for p in proposals]
    if any(any_finalized):
        await db.commit()

    user_votes: dict[int, VoteChoice] = {}
    if current_user is not None and proposals:
        vote_result = await db.execute(
            select(Vote).where(
                Vote.voter_address == current_user.wallet_address,
                Vote.proposal_id.in_([p.id for p in proposals]),
            )
        )
        user_votes = {v.proposal_id: v.choice for v in vote_result.scalars().all()}

    return [
        ProposalRead(**_proposal_fields(p, eligible_voters, user_votes.get(p.id))) for p in proposals
    ]


@router.get("/{proposal_id}", response_model=ProposalDetailRead)
async def get_proposal(
    proposal_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = Depends(get_optional_current_user),
) -> ProposalDetailRead:
    proposal = await _get_proposal_or_404(proposal_id, db)
    eligible_voters = await _total_eligible_voters(db)

    if _finalize_if_due(proposal, eligible_voters):
        await db.commit()
        await db.refresh(proposal)

    vote_result = await db.execute(
        select(Vote).where(Vote.proposal_id == proposal_id).order_by(Vote.created_at.asc())
    )
    votes = list(vote_result.scalars().all())
    user_vote = next(
        (v.choice for v in votes if current_user and v.voter_address == current_user.wallet_address),
        None,
    )

    fields = _proposal_fields(proposal, eligible_voters, user_vote)
    return ProposalDetailRead(**fields, votes=[VoteRead.model_validate(v) for v in votes])


@router.post("", response_model=ProposalRead, status_code=status.HTTP_201_CREATED)
async def create_proposal(
    payload: ProposalCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProposalRead:
    now = datetime.now(timezone.utc)
    proposal = Proposal(
        title=payload.title,
        description=payload.description,
        category=payload.category,
        proposer_address=current_user.wallet_address,
        status=ProposalStatus.ACTIVE,
        start_time=now,
        end_time=now + timedelta(days=payload.voting_period_days),
        quorum_threshold=payload.quorum_threshold,
        pass_threshold=payload.pass_threshold,
    )
    db.add(proposal)
    await db.commit()
    await db.refresh(proposal)

    eligible_voters = await _total_eligible_voters(db)
    return ProposalRead(**_proposal_fields(proposal, eligible_voters, user_vote=None))


@router.post("/{proposal_id}/vote", response_model=ProposalRead)
async def cast_vote(
    proposal_id: int,
    payload: VoteCreate,
    db: AsyncSession = Depends(get_db),
    # ROADMAP.md Part 4 6.1 — see routers/escrows.py::create_escrow's own
    # note on require_user_with_scope.
    current_user: User = Depends(require_user_with_scope("vote:cast")),
) -> ProposalRead:
    proposal = await _get_proposal_for_update_or_404(proposal_id, db)

    if proposal.status != ProposalStatus.ACTIVE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Voting is closed for this proposal."
        )
    if datetime.now(timezone.utc) >= _aware(proposal.end_time):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Voting period has ended.")

    weight = _voting_power(current_user)

    result = await db.execute(
        select(Vote).where(
            Vote.proposal_id == proposal_id, Vote.voter_address == current_user.wallet_address
        )
    )
    existing = result.scalar_one_or_none()

    if existing is not None:
        _adjust_tally(proposal, existing.choice, -existing.voting_power)
        existing.choice = payload.choice
        existing.voting_power = weight
    else:
        db.add(
            Vote(
                proposal_id=proposal_id,
                voter_address=current_user.wallet_address,
                choice=payload.choice,
                voting_power=weight,
            )
        )

    _adjust_tally(proposal, payload.choice, weight)

    await db.commit()
    await db.refresh(proposal)

    eligible_voters = await _total_eligible_voters(db)
    return ProposalRead(**_proposal_fields(proposal, eligible_voters, user_vote=payload.choice))


@router.post("/{proposal_id}/finalize", response_model=ProposalRead)
async def finalize_proposal(
    proposal_id: int,
    db: AsyncSession = Depends(get_db),
) -> ProposalRead:
    """Idempotent — an already-finalized proposal is returned as-is rather
    than re-evaluated, so calling this twice is always safe. Raises 400 if
    `end_time` hasn't arrived yet; a future bulk sweep (ROADMAP.md Part 1's
    cron) should filter to `end_time <= now()` itself before calling this
    per-id rather than relying on the 400 to skip early proposals.
    """
    proposal = await _get_proposal_for_update_or_404(proposal_id, db)
    eligible_voters = await _total_eligible_voters(db)

    if proposal.status != ProposalStatus.ACTIVE:
        return ProposalRead(**_proposal_fields(proposal, eligible_voters, user_vote=None))

    if datetime.now(timezone.utc) < _aware(proposal.end_time):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Voting is still open; ends at {proposal.end_time.isoformat()}.",
        )

    _finalize_if_due(proposal, eligible_voters)  # status is ACTIVE and past due — always True here

    await db.commit()
    await db.refresh(proposal)
    return ProposalRead(**_proposal_fields(proposal, eligible_voters, user_vote=None))


@router.post("/{proposal_id}/execute", response_model=ProposalRead)
async def execute_proposal(
    proposal_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProposalRead:
    """Moves a PASSED proposal to EXECUTED — the formal "this decision has
    been enacted" marker. Not idempotent like finalize: a proposal can only
    be executed once, so a second call 400s rather than silently returning
    the same result, matching disputes.py's enforce_ruling precedent for
    the same "who did this and when" shape (executed_by/executed_at here,
    enforced_by/resolved_at there).

    No real on-chain effect is wired up yet (no treasury transfer, no
    parameter change) — see ROADMAP.md Part 3; this is deliberately scoped
    to just the status transition until there's a real effect to apply.
    """
    proposal = await _get_proposal_for_update_or_404(proposal_id, db)

    # Checked in this order so re-executing an already-executed proposal
    # reports "already executed" specifically, rather than the more
    # generic "not passed" (status has already moved to EXECUTED by then,
    # which would otherwise mask the more useful message).
    if proposal.executed_at is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Proposal already executed.")
    if proposal.status != ProposalStatus.PASSED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only a passed proposal can be executed.",
        )

    proposal.status = ProposalStatus.EXECUTED
    proposal.executed_by = current_user.wallet_address
    proposal.executed_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(proposal)

    eligible_voters = await _total_eligible_voters(db)
    return ProposalRead(**_proposal_fields(proposal, eligible_voters, user_vote=None))
