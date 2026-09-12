"""Pydantic V2 request/response schemas.

Every model uses ConfigDict (not the V1 `class Config`) and field_validator
(not the V1 `@validator`) per the project's Pydantic V2 requirement.

Governance's schemas live in governance.py instead — see
app/schemas/__init__.py for the re-export that makes the split invisible
to every other importer.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.enums import ChainStatus, ConsensusSubjectType, StatusKey

_WALLET_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
# GenLayer/EVM transaction hashes are 32 bytes, same shape as an Ethereum
# tx hash — 0x + 64 hex chars. Deliberately looser than _WALLET_RE's exact
# use (this only guards against obviously-wrong input like an address or
# empty string; the indexer is what actually verifies a hash means
# anything, by reading real chain state back — see genlayer_indexer.py's
# own header on that trust boundary).
_TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


def _normalize_wallet(v: str) -> str:
    """Shared by every DTO that accepts a wallet address: strips whitespace
    and lowercases it. Storage/lookups are lowercase throughout (User.wallet_
    address is the PK) so a checksummed and lowercased address for the same
    wallet always resolve to the same row."""
    v = v.strip()
    if not _WALLET_RE.match(v):
        raise ValueError("wallet_address must be a 0x-prefixed 40-hex-character address.")
    return v.lower()


# --- User & Settings --------------------------------------------------------


class UserSettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    notify_on: bool = True
    auto_escalate_on: bool = False


class UserSettingsUpdate(BaseModel):
    notify_on: bool | None = None
    auto_escalate_on: bool | None = None


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    wallet_address: str
    display_name: str | None = None
    created_at: datetime
    settings: UserSettingsRead | None = None


class UserUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=100)


# --- Auth ---------------------------------------------------------------


class NonceRequest(BaseModel):
    wallet_address: str

    _normalize = field_validator("wallet_address")(_normalize_wallet)


class NonceResponse(BaseModel):
    nonce: str
    message: str


class VerifyRequest(BaseModel):
    wallet_address: str
    message: str
    signature: str

    _normalize = field_validator("wallet_address")(_normalize_wallet)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    wallet_address: str


# --- Milestone ----------------------------------------------------------


class MilestoneRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    amount: Decimal
    status_key: StatusKey
    criteria: str
    order_index: int
    # Null until this specific milestone is linked to an index inside its
    # escrow's deployed NuanceEscrow contract — see Milestone.on_chain_index's
    # own docstring. The frontend's cutover check is per-milestone: submit
    # on-chain only once this (and EscrowRead.contract_address) are both set.
    on_chain_index: int | None = None
    chain_status: ChainStatus = ChainStatus.LEGACY_OFFCHAIN
    on_chain_tx_hash: str | None = None
    # The validator committee's own stated reasoning — see
    # Milestone.reasoning's own docstring.
    reasoning: str | None = None
    # Set once this milestone has actually been paid out via POST
    # /escrows/{id}/release — see Milestone.released_at's own docstring.
    # Null means either not yet approved, or approved but not released.
    released_at: datetime | None = None


# --- Asset (ROADMAP.md Part 4 6.2) ---------------------------------------


class AssetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    symbol: str
    decimals: int
    contract_address: str | None = None
    is_native: bool


# --- Escrow -------------------------------------------------------------


class EscrowCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=200)
    counterparty_address: str
    total: Decimal = Field(gt=0)
    criteria: str | None = Field(default=None, max_length=2000)
    # Which Asset this escrow is denominated in — a human-friendly symbol
    # ("GEN", "USDC"), not a raw asset_id a caller would otherwise have to
    # already know. Defaults to "GEN" so every existing caller (frontend,
    # tests, any script written before this field existed) keeps working
    # unchanged — omitting this is not an error, it's "the same behavior
    # as before multi-asset support existed."
    asset_symbol: str = Field(default="GEN", max_length=20)

    _normalize_counterparty = field_validator("counterparty_address")(_normalize_wallet)

    @field_validator("criteria")
    @classmethod
    def default_criteria(cls, v: str | None) -> str | None:
        return v or None

    @field_validator("asset_symbol")
    @classmethod
    def _normalize_asset_symbol(cls, v: str) -> str:
        v = v.strip().upper()
        if not v:
            raise ValueError("asset_symbol can't be blank.")
        return v


class EscrowRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    creator_address: str
    counterparty_address: str
    title: str
    total: Decimal
    asset: AssetRead
    status_key: StatusKey
    created_at: datetime
    milestones: list[MilestoneRead] = []
    # Which deployed NuanceEscrow instance backs this escrow, if any — see
    # Escrow.contract_address's own docstring. Null is the normal/expected
    # state for an escrow whose auto-deploy hasn't finished yet (it runs in
    # the background, can take a few minutes); the frontend treats null as
    # "route this through the legacy off-chain path," same convention
    # lib/chain-config.ts already documents.
    contract_address: str | None = None
    # Whether a real fund_escrow() transaction has been sent — see
    # Escrow.funded_tx_hash's own docstring on why this isn't the same
    # thing as the contract's own funded_amount.
    funded_tx_hash: str | None = None
    # Set once a real cancel_escrow() transaction has been sent and
    # acknowledged — see Escrow.cancelled_tx_hash's own docstring.
    cancelled_tx_hash: str | None = None


# --- Deliverable submission -----------------------------------------------


class DeliverableSubmissionCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    text: str = Field(min_length=1, max_length=5000)

    @field_validator("text")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v:
            raise ValueError("Deliverable text can't be blank.")
        return v


class DeliverableSubmissionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    milestone_id: int
    wallet: str
    text: str
    submitted_at: datetime
    consensus_job_id: int | None = None


class OnChainSubmissionAck(BaseModel):
    """Body for POST /escrows/{id}/deliverable/on-chain — the frontend
    reporting a tx hash it already got back from signing and sending
    `NuanceEscrow.submit_deliverable` itself (see components/app/
    genlayer-write-client.ts). This endpoint only remembers the hash for
    services/genlayer_indexer.py to poll; it is NOT a trust boundary for
    the verdict — status_key/deliverable text only ever change once the
    indexer reads the real result back from the contract's own get_milestone
    view. A caller reporting a bogus hash can make the indexer log a failed
    lookup; it can never fake an approval this way."""

    model_config = ConfigDict(str_strip_whitespace=True)

    tx_hash: str

    @field_validator("tx_hash")
    @classmethod
    def _validate_tx_hash(cls, v: str) -> str:
        if not _TX_HASH_RE.match(v):
            raise ValueError("tx_hash must be a 0x-prefixed 64-hex-character transaction hash.")
        return v.lower()


class OnChainFundAck(BaseModel):
    """Body for POST /escrows/{id}/fund/on-chain — the frontend reporting
    a tx hash it already got back from signing and sending a real,
    *payable* NuanceEscrow.fund_escrow transaction (components/app/
    genlayer-write-client.ts's fundEscrowOnChain) — real GEN actually left
    the creator's wallet and now sits in the deployed contract's balance.
    Same "not a trust boundary" reasoning as OnChainSubmissionAck: this
    only remembers that a fund_escrow call was sent, for UI purposes
    (hide the "Fund Escrow" action once it has); the contract's own
    funded_amount (checked by release_milestone before any payout) is the
    real source of truth regardless of what this endpoint is told."""

    model_config = ConfigDict(str_strip_whitespace=True)

    tx_hash: str

    @field_validator("tx_hash")
    @classmethod
    def _validate_tx_hash(cls, v: str) -> str:
        if not _TX_HASH_RE.match(v):
            raise ValueError("tx_hash must be a 0x-prefixed 64-hex-character transaction hash.")
        return v.lower()


class OnChainCancelAck(BaseModel):
    """Body for POST /escrows/{id}/cancel/on-chain — the frontend
    reporting a tx hash it already got back from signing and sending a
    real NuanceEscrow.cancel_escrow transaction (components/app/
    genlayer-write-client.ts's cancelEscrowOnChain).

    Unlike OnChainFundAck/OnChainSubmissionAck, this DOES immediately
    flip status_key to StatusKey.CANCELLED — same trust level as
    raise_dispute_on_chain's own ack already uses (create the local
    record from what the caller reports, rather than waiting on an
    indexer read). Safe here for the same reason: cancel_escrow's real
    enforcement lives entirely on the contract itself — submit_
    deliverable/fund_escrow/release_milestone all check the contract's
    own `status` field directly, never this app's DB. A caller falsely
    claiming a cancellation that never actually happened on-chain can
    only produce a stale/wrong *local* status badge, never let anyone
    bypass what the contract actually enforces."""

    model_config = ConfigDict(str_strip_whitespace=True)

    tx_hash: str

    @field_validator("tx_hash")
    @classmethod
    def _validate_tx_hash(cls, v: str) -> str:
        if not _TX_HASH_RE.match(v):
            raise ValueError("tx_hash must be a 0x-prefixed 64-hex-character transaction hash.")
        return v.lower()


# --- Consensus job --------------------------------------------------------


class ValidatorResult(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str
    vote: str
    confidence: int = Field(ge=0, le=100)
    reasoning: str
    # Which provider actually produced this verdict — "gemini" / "anthropic"
    # / "openai" on success, or "heuristic" if every configured provider
    # failed and the deterministic offline fallback answered instead.
    # Optional/nullable so older stored ConsensusJob rows (persisted before
    # this field existed) still deserialize cleanly.
    provider: str | None = None


class ConsensusJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    subject_type: ConsensusSubjectType
    subject_id: int
    stage: int
    validator_results: list[ValidatorResult] | None = None
    verdict_label: str | None = None
    verdict_approved: bool | None = None
    verdict_confidence: int | None = None
    verdict_reasoning: str | None = None
    created_at: datetime
    completed_at: datetime | None = None


class ConsensusVerdict(BaseModel):
    label: str
    approved: bool
    confidence: int
    reasoning: str


class ConsensusStatus(BaseModel):
    stage: int
    validator_results: list[ValidatorResult] | None = None
    verdict: ConsensusVerdict | None = None


# --- Dispute --------------------------------------------------------------


class DisputeCreate(BaseModel):
    """Body for POST /escrows/{id}/dispute — escalating a milestone's AI
    verdict to a formal Dispute Court review. `issue` is optional: the
    "Escalate to Internet Court" button (components/app/views/
    escrow-detail-view.tsx) fires this with no form of its own, so the
    endpoint fills in a reasonable default from the milestone's most
    recent ConsensusJob reasoning when omitted — see routers/escrows.py's
    raise_dispute for that logic. Free-text override kept for any future
    caller that does want to state its own claim."""

    model_config = ConfigDict(str_strip_whitespace=True)

    issue: str | None = Field(default=None, max_length=5000)


class OnChainDisputeAck(BaseModel):
    """Body for POST /escrows/{id}/dispute/on-chain — the frontend
    reporting a tx hash it already got back from signing and sending
    `NuanceDisputeCourt.file_dispute` itself (see components/app/
    genlayer-write-client.ts). Unlike OnChainSubmissionAck (which updates
    an existing Milestone), this one CREATES the local Dispute row
    immediately — file_dispute assigns the dispute's id on-chain, which
    isn't known yet at ack time. See services/genlayer_indexer.py's
    resolve_pending_dispute_ids for how on_chain_dispute_id gets filled in
    once the transaction actually lands. `issue` mirrors DisputeCreate's
    own optional-with-a-server-side-default behavior, and MUST match the
    `claim_statement` argument the frontend actually passed to
    file_dispute — the indexer matches on exact text equality, not fuzzy
    matching."""

    model_config = ConfigDict(str_strip_whitespace=True)

    tx_hash: str
    issue: str | None = Field(default=None, max_length=5000)

    @field_validator("tx_hash")
    @classmethod
    def _validate_tx_hash(cls, v: str) -> str:
        if not _TX_HASH_RE.match(v):
            raise ValueError("tx_hash must be a 0x-prefixed 64-hex-character transaction hash.")
        return v.lower()


class DisputeMessageCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    content: str = Field(min_length=1, max_length=5000)

    @field_validator("content")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v:
            raise ValueError("Message content can't be blank.")
        return v


class DisputeMessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dispute_id: int
    sender_address: str
    content: str
    created_at: datetime


class DisputeEvidenceCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    description: str = Field(min_length=1, max_length=5000)
    link: str | None = Field(default=None, max_length=1000)

    @field_validator("description")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v:
            raise ValueError("Evidence description can't be blank.")
        return v


class OnChainEvidenceAck(BaseModel):
    """Body for POST /disputes/{id}/evidence/on-chain — the frontend
    reporting a tx hash it already got back from signing and sending a
    real NuanceDisputeCourt.add_evidence transaction (components/app/
    genlayer-write-client.ts's addEvidenceOnChain). Unlike the off-chain
    submit_evidence, this does NOT queue a ConsensusJob — the real
    judgment happens via adjudicate_dispute on the contract itself
    (triggered automatically by services/genlayer_indexer.py, or
    manually). `evidence_url` is required (unlike the off-chain path's
    optional `link`) because the contract's own add_evidence only ever
    takes a URL — there's nowhere for free-text-only evidence to go
    on-chain (see that contract method's own docstring)."""

    model_config = ConfigDict(str_strip_whitespace=True)

    tx_hash: str
    evidence_url: str = Field(min_length=1, max_length=1000)

    @field_validator("tx_hash")
    @classmethod
    def _validate_tx_hash(cls, v: str) -> str:
        if not _TX_HASH_RE.match(v):
            raise ValueError("tx_hash must be a 0x-prefixed 64-hex-character transaction hash.")
        return v.lower()

    @field_validator("evidence_url")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v:
            raise ValueError("evidence_url can't be blank.")
        return v


class DisputeEvidenceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    dispute_id: int
    submitter_address: str
    description: str
    link: str | None = None
    created_at: datetime
    consensus_job_id: int | None = None


class DisputeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    escrow_id: int
    milestone_id: int | None = None
    opened_by_address: str
    issue: str
    status_key: StatusKey
    ruling: str | None = None
    enforced_by: str | None = None
    created_at: datetime
    resolved_at: datetime | None = None
    messages: list[DisputeMessageRead] = []
    evidence: list[DisputeEvidenceRead] = []
    # Added alongside raise_dispute_on_chain — missed when the other three
    # chain-linkage fields (Escrow/Milestone/Prediction) were added earlier,
    # since disputes weren't wired to the chain yet at that point. See
    # Dispute.on_chain_dispute_id's own model docstring: null until
    # services/genlayer_indexer.py's resolve_pending_dispute_ids matches it.
    on_chain_dispute_id: int | None = None
    chain_status: ChainStatus = ChainStatus.LEGACY_OFFCHAIN
    on_chain_tx_hash: str | None = None
    # The adjudicate_dispute tx services/genlayer_indexer.py's
    # trigger_pending_adjudications sent, once on_chain_dispute_id is
    # known — a separate transaction from on_chain_tx_hash (file_dispute).
    # Null until a trigger has actually been sent.
    adjudication_tx_hash: str | None = None


class DisputeCreateRead(DisputeRead):
    """DisputeRead plus the id of the ConsensusJob raise_dispute queues —
    same reasoning DeliverableSubmissionRead/DisputeEvidenceRead already
    carry one: the frontend needs a real job id back from the 201 to start
    polling GET /consensus/{id} immediately, not a second round-trip to
    find it. Not on DisputeRead itself — GET /disputes/{id} has no single
    "the" job id to report once a dispute may have been through several."""

    consensus_job_id: int | None = None


class DisputeEnforceRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    approved: bool
    ruling: str | None = Field(default=None, max_length=2000)


# --- Prediction -----------------------------------------------------------


class PredictionPositionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    prediction_id: int
    wallet_address: str
    side: str
    amount: int
    payout: float | None = 0.0
    status: str = "PENDING"
    created_at: datetime


class PredictionCreate(BaseModel):
    """Body for POST /predictions — a real person authoring a real
    market, replacing services/market_generator.py's tweet-scraping
    pipeline as the actual way new markets get made (2026-09-12 rebrand:
    the auto-generated questions were "Will this GenLayer claim hold
    true: [raw tweet fragment]?" — incoherent, and every one required
    GEMINI_API_KEY to even formulate). No LLM involved here — the
    creator writes the question and criteria directly, so content is
    sensible because a person wrote it.

    resolution_source_url is REQUIRED, not optional like Prediction's own
    column — this app now only creates markets that deploy a real
    NuancePredictionMarket contract (routers/predictions.py's
    create_prediction), and NuancePredictionMarket.resolve_market has
    nothing to fetch/judge against without one; services/genlayer_deploy.
    py's deploy_prediction_contract already skips deploy silently when
    it's empty, which would leave this market permanently stuck off-chain
    and unbettable under the on-chain-only policy this endpoint enforces.
    """

    model_config = ConfigDict(str_strip_whitespace=True)

    title: str = Field(min_length=10, max_length=300)
    description: str = Field(min_length=20, max_length=3000)
    category: str = Field(min_length=1, max_length=60)
    resolution_date: datetime
    resolution_source_url: str = Field(min_length=1, max_length=2000)

    @field_validator("title")
    @classmethod
    def _title_is_a_question(cls, v: str) -> str:
        if not v.rstrip().endswith("?"):
            raise ValueError("title must be phrased as a yes/no question, ending in '?'.")
        return v

    @field_validator("resolution_source_url")
    @classmethod
    def _validate_resolution_source_url(cls, v: str) -> str:
        v = v.strip()
        if not (v.startswith("https://") or v.startswith("http://")):
            raise ValueError("resolution_source_url must start with http:// or https://.")
        return v

    @field_validator("resolution_date")
    @classmethod
    def _resolution_date_in_future(cls, v: datetime) -> datetime:
        deadline = v if v.tzinfo is not None else v.replace(tzinfo=timezone.utc)
        if deadline <= datetime.now(timezone.utc):
            raise ValueError("resolution_date must be in the future.")
        return v


class PredictionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    description: str
    category: str
    resolution_date: datetime
    volume: int
    status_key: str
    outcome: str | None = None
    resolution_reasoning: str | None = None
    resolution_source_url: str | None = None
    created_at: datetime
    resolved_at: datetime | None = None
    positions: list[PredictionPositionRead] = []
    # Which deployed NuancePredictionMarket instance backs this market —
    # null for almost every market today (see Prediction.contract_address's
    # own model docstring). Once set, betting/resolution route on-chain.
    contract_address: str | None = None
    chain_status: ChainStatus = ChainStatus.LEGACY_OFFCHAIN
    resolution_trigger_tx_hash: str | None = None


def _validate_side(v: str) -> str:
    v_norm = v.strip().upper()
    if v_norm not in ("YES", "NO"):
        raise ValueError("Side must be 'YES' or 'NO'.")
    return v_norm


# Bet amounts are milli-GEN (1 GEN = 1000 units) — an integer unit, not a
# renamed dollar figure, chosen specifically so a fractional GEN amount
# (0.5 GEN, the smallest preset) is still a whole number in the DB's
# existing `amount: int` column with no schema/column-type migration
# needed. The quick-pick buttons (components/app/views/
# prediction-detail-view.tsx) are the ONLY way to bet — no free-text
# amount input — so the backend validates against this exact set rather
# than a loose range; the frontend can't be trusted to enforce this alone.
BET_AMOUNTS_MILLI_GEN = (500, 1000, 2000, 3000)  # 0.5 / 1 / 2 / 3 GEN


def _validate_bet_amount(v: int) -> int:
    if v not in BET_AMOUNTS_MILLI_GEN:
        allowed = ", ".join(f"{a / 1000:g}" for a in BET_AMOUNTS_MILLI_GEN)
        raise ValueError(f"amount must be one of the offered bet sizes ({allowed} GEN).")
    return v


class PredictionBetCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    side: str
    amount: int = Field(gt=0, le=1_000_000)

    _normalize_side = field_validator("side")(_validate_side)
    _validate_amount = field_validator("amount")(_validate_bet_amount)


class OnChainBetAck(BaseModel):
    """Body for POST /predictions/{id}/bet/on-chain — the frontend
    reporting a tx hash it already got back from signing and sending
    NuancePredictionMarket.bet itself (see components/app/
    genlayer-write-client.ts's betOnChain). Unlike a regular write ack,
    this ALSO carries side/amount: the real stake already lives in the
    contract's own storage, but this app still mirrors it into a
    PredictionPosition row immediately (same reasoning
    OnChainSubmissionAck's docstring gives for milestones) so the existing
    "my positions" UI keeps working without waiting on an indexer cycle
    that doesn't sync individual bettors' stakes at all today."""

    model_config = ConfigDict(str_strip_whitespace=True)

    tx_hash: str
    side: str
    amount: int = Field(gt=0, le=1_000_000)

    _normalize_side = field_validator("side")(_validate_side)
    _validate_amount = field_validator("amount")(_validate_bet_amount)

    @field_validator("tx_hash")
    @classmethod
    def _validate_tx_hash(cls, v: str) -> str:
        if not _TX_HASH_RE.match(v):
            raise ValueError("tx_hash must be a 0x-prefixed 64-hex-character transaction hash.")
        return v.lower()


# --- Validator / Agent directories -----------------------------------------
#
# Both are computed on read from real history (ConsensusJob rows) — see
# routers/validators.py and routers/agents.py — not stored anywhere, so
# there's no *Create schema, only a read shape.


class ValidatorStatRead(BaseModel):
    name: str
    cases_judged: int
    accuracy_pct: float
    is_active: bool
    last_active_at: datetime | None = None
    # Which provider ("gemini"/"anthropic"/"openai"/"heuristic") answered
    # this validator's most recent completed case — see
    # services/consensus.py's ValidatorResult.provider. None if it has no
    # cases yet.
    last_provider: str | None = None


class AgentStatRead(BaseModel):
    wallet_address: str
    category: str
    cases_judged: int
    trust_score: int


class AgentCaseRead(BaseModel):
    """One judged case in an agent's real history — the "transaction
    drill-down" ROADMAP.md Part 4's Real Agent Directory item calls for.
    `AgentStatRead` above was already computed from real `ConsensusJob`
    rows (not seed data — see routers/agents.py's own docstring); what
    was actually missing was any way to see *which* cases a trust score
    was built from. `escrow_id` is always present (a dispute's own
    `escrow_id`, or the milestone's) so the frontend can link straight
    back to the real escrow/dispute detail view."""

    consensus_job_id: int
    subject_type: str  # "milestone" | "dispute" — enums.ConsensusSubjectType's value
    subject_id: int  # milestones.id or disputes.id, matching subject_type
    escrow_id: int
    dispute_id: int | None = None
    title: str  # milestone name, or the dispute's issue text
    verdict_label: str | None = None
    verdict_approved: bool | None = None
    verdict_confidence: int | None = None
    verdict_reasoning: str | None = None
    completed_at: datetime | None = None


# --- Analytics --------------------------------------------------------------
#
# ROADMAP.md Part 3 5.5 — GET /analytics/overview (routers/analytics.py),
# backing the frontend's AnalyticsView. Computed live from real rows on
# every request, same as validators/agents above — no materialized/cached
# table yet (5.5's second checkbox item), a deliberate scope cut given this
# pass's size, not a silent drop: see routers/analytics.py's own docstring.


class AnalyticsOverview(BaseModel):
    # Sum of every not-yet-released milestone amount on every non-cancelled
    # escrow — real "value still locked", not just "every escrow that
    # exists" (a fully-paid-out escrow has nothing left locked in it).
    tvl_open_escrows_gen: Decimal
    open_escrow_count: int
    # None if no dispute has ever been resolved yet — there's no
    # meaningful median of zero samples.
    dispute_resolution_median_hours: float | None
    resolved_dispute_count: int
    # Position/Prediction.volume is stored in milli-GEN (BET_AMOUNTS_
    # MILLI_GEN) — converted to GEN here so this response's units match
    # tvl_open_escrows_gen's.
    prediction_market_volume_gen: Decimal
    prediction_market_count: int
    validator_leaderboard: list[ValidatorStatRead]
    generated_at: datetime


# --- API keys (ROADMAP.md Part 4 6.1) --------------------------------------
#
# Every scope this app currently recognizes — routers/api_keys.py's
# require_scope rejects any scope not in this list at issuance time
# (typo'd/made-up scopes fail loudly, not silently grant nothing) and
# checks a request's key carries the one a protected route declares.
API_KEY_SCOPES = frozenset({"escrow:create", "bet:place", "evidence:submit", "vote:cast"})


class ApiKeyCreate(BaseModel):
    label: str | None = Field(default=None, max_length=100)
    scopes: list[str] = Field(min_length=1)

    @field_validator("scopes")
    @classmethod
    def _validate_scopes(cls, v: list[str]) -> list[str]:
        unknown = sorted(set(v) - API_KEY_SCOPES)
        if unknown:
            raise ValueError(
                f"Unknown scope(s): {', '.join(unknown)}. Valid scopes: "
                f"{', '.join(sorted(API_KEY_SCOPES))}."
            )
        return sorted(set(v))


class ApiKeyRead(BaseModel):
    """What GET /auth/api-keys lists — deliberately never includes the
    secret (not even hashed) or enough of key_id to reconstruct a working
    key; see ApiKeyIssueResponse for the one time the real key is ever
    shown."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    key_id: str
    label: str | None = None
    scopes: list[str]
    created_at: datetime
    last_used_at: datetime | None = None
    revoked_at: datetime | None = None


class ApiKeyIssueResponse(BaseModel):
    """POST /auth/api-keys's response — the ONLY time `api_key` (the full
    "nuance_live_<key_id>_<secret>" credential) is ever returned. See
    models.core.ApiKey's own docstring on why: only a hash of the secret
    half is stored, so there's no "look it up again later" path — losing
    this means issuing a new key."""

    id: int
    key_id: str
    api_key: str
    label: str | None = None
    scopes: list[str]
    created_at: datetime


# --- Webhooks (ROADMAP.md Part 4 6.1) --------------------------------------

WEBHOOK_EVENT_TYPES = frozenset({"consensus.completed", "dispute.resolved", "prediction.resolved"})


class WebhookCreate(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    event_types: list[str] = Field(min_length=1)

    @field_validator("url")
    @classmethod
    def _validate_url(cls, v: str) -> str:
        v = v.strip()
        if not (v.startswith("https://") or v.startswith("http://")):
            raise ValueError("url must start with http:// or https://.")
        return v

    @field_validator("event_types")
    @classmethod
    def _validate_event_types(cls, v: list[str]) -> list[str]:
        unknown = sorted(set(v) - WEBHOOK_EVENT_TYPES)
        if unknown:
            raise ValueError(
                f"Unknown event_type(s): {', '.join(unknown)}. Valid types: "
                f"{', '.join(sorted(WEBHOOK_EVENT_TYPES))}."
            )
        return sorted(set(v))


class WebhookRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    url: str
    event_types: list[str]
    is_active: bool
    created_at: datetime
    last_delivered_at: datetime | None = None
    last_delivery_status: int | None = None


class WebhookCreateResponse(WebhookRead):
    """POST /webhooks's response — the only time `secret` is ever
    returned; see models.core.Webhook's own docstring on why this one
    (unlike an ApiKey's secret) can't just be hashed: it has to stay
    usable server-side to keep signing every future delivery. Callers
    that lose it must delete and re-register the webhook to get a new one
    (there's no "rotate secret" endpoint yet — out of scope for this
    pass)."""

    secret: str

