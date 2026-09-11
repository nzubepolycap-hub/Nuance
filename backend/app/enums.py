"""Shared enums — imported by both models.py (SQLAlchemy columns) and
schemas.py (Pydantic fields) so the two layers can't drift apart.

Mirrors the frontend's components/app/types.ts:
  - StatusKey -> StatusKey
  - the escrow/dispute "view" concept has no backend equivalent (routing is
    frontend-only), everything else here is new state the frontend doesn't
    model explicitly today (ConsensusJob's subject_type / stage).
"""

from __future__ import annotations

from enum import IntEnum, StrEnum


class StatusKey(StrEnum):
    APPROVED = "approved"
    IN_REVIEW = "in_review"
    IN_PROGRESS = "in_progress"
    PENDING = "pending"
    DISPUTED = "disputed"
    # A dispute whose claim was rejected by consensus (counterparty's
    # position/delivery stood) — distinct from DISPUTED, which means "still
    # open/unresolved". Only ever set on a Dispute row, never a Milestone or
    # Escrow — see services/consensus.py::_apply_verdict_to_state.
    REJECTED = "rejected"
    # The creator cancelled and reclaimed their funded GEN before any
    # milestone was approved — see contracts/nuance_escrow.py's
    # cancel_escrow() and routers/escrows.py's cancel_escrow_on_chain.
    # Only ever set on an Escrow row, never a Milestone or Dispute.
    CANCELLED = "cancelled"


class ConsensusSubjectType(StrEnum):
    """What a ConsensusJob is adjudicating. Only MILESTONE is wired up by
    this prompt; DISPUTE is reserved for the disputes prompt so the column's
    allowed values don't need to change later."""

    MILESTONE = "milestone"
    DISPUTE = "dispute"


class ConsensusStage(IntEnum):
    """Mirrors the `stage` state machine already in nuance-app.tsx
    (submitDeliverable/submitEvidence) so the backend can drive the same
    ConsensusPanel UI via polling instead of the frontend's local timers.
    """

    IDLE = 0
    QUEUED = 1
    ANALYZING = 2
    DONE = 3


class ProposalStatus(StrEnum):
    """A governance proposal's lifecycle. `_finalize_if_due` (routers/
    governance.py) is the only logic that moves ACTIVE -> PASSED/REJECTED
    — called both by the explicit POST /proposals/{id}/finalize endpoint
    and, as of 2026-09-10, lazily by list_proposals/get_proposal so a
    proposal doesn't stay stuck at ACTIVE forever just because nothing
    ever called finalize on it. EXECUTED is reserved for a future action
    that actually applies a passed proposal's effect (see ROADMAP.md Part
    1) and isn't set by anything but the explicit execute endpoint."""

    ACTIVE = "active"
    PASSED = "passed"
    REJECTED = "rejected"
    EXECUTED = "executed"


class VoteChoice(StrEnum):
    FOR = "for"
    AGAINST = "against"
    ABSTAIN = "abstain"


class ChainStatus(StrEnum):
    """Mirrors lib/chain-status.ts's ChainStatus (LEGACY_OFFCHAIN +
    ChainStatusBucket) value-for-value — same reason StatusKey above
    mirrors types.ts: that file already collapses GenLayer's real 14-value
    TransactionStatus into this 4-bucket + legacy shape (via the SDK's own
    isDecidedState(), not a hand-copied list — see that file's header),
    and duplicating a *different* vocabulary here would let the two
    drift. scripts/genlayer-read.ts computes the bucket (it has
    genlayer-js loaded); services/genlayer_indexer.py only ever writes
    one of these five strings into a row's chain_status column.

    Every Milestone/Dispute/Prediction row defaults to LEGACY_OFFCHAIN and
    stays there until it's actually linked on-chain (Escrow.contract_address
    / Prediction.contract_address / Dispute.on_chain_dispute_id set) — see
    ROADMAP.md 4.5's deferred "add this together with the actual cutover"
    note; this is that column, added once there's a real indexer to drive
    it rather than speculatively ahead of one.
    """

    LEGACY_OFFCHAIN = "legacy_offchain"
    PROCESSING = "processing"
    DECIDED = "decided"
    FINALIZED = "finalized"
    CANCELED = "canceled"
