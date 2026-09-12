export type StatusKey =
  | "approved"
  | "in_review"
  | "in_progress"
  | "pending"
  | "disputed"
  // A dispute whose claim was rejected by consensus — only ever set on a
  // Dispute, never a Milestone/Escrow. Distinct from "disputed" (still open).
  | "rejected"
  // The creator cancelled and reclaimed their funded GEN before any
  // milestone was approved — only ever set on an Escrow, never a
  // Milestone/Dispute. See components/app/genlayer-write-client.ts's
  // cancelEscrowOnChain.
  | "cancelled";

export type View =
  | "dashboard"
  | "detail"
  | "create"
  | "predictions"
  | "createMarket"
  | "predictionDetail"
  | "disputes"
  | "disputeDetail"
  | "governance"
  | "validators"
  | "agents"
  | "agentDetail"
  | "analytics"
  | "settings";

export interface Milestone {
  name: string;
  amount: number;
  statusKey: StatusKey;
  criteria: string;
  // "legacy_offchain" unless this milestone has actually had a real
  // on-chain submit_deliverable transaction sent against it — that's
  // NOT the same as whether it's *capable* of one. A milestone can be
  // fully linked (onChainIndex set) with chainStatus still
  // "legacy_offchain" simply because nothing's been submitted to it
  // yet — see components/app/chain-status-badge.tsx, which needs
  // onChainIndex too so it doesn't call a not-yet-tried milestone
  // "off-chain" when it's actually on-chain-ready.
  chainStatus?: import("@/lib/chain-status").ChainStatus;
  onChainTxHash?: string | null;
  // This milestone's index inside its escrow's deployed NuanceEscrow
  // contract — null until linked. See lib/api.ts's ApiMilestone.on_chain_index.
  onChainIndex?: number | null;
  // The validator committee's own stated reasoning. See lib/api.ts's
  // ApiMilestone.reasoning.
  reasoning?: string | null;
  // Set once this milestone has actually been paid out. See lib/api.ts's
  // ApiMilestone.released_at.
  releasedAt?: string | null;
}

// ROADMAP.md Part 4 6.2 — the settlement currency escrow.total/every
// milestone's amount is denominated in (a milestone has no asset of its
// own; every milestone in one escrow shares its parent escrow's).
export interface Asset {
  id: number;
  symbol: string;
  decimals: number;
  contractAddress: string | null;
  isNative: boolean;
}

export interface Escrow {
  id: number;
  title: string;
  creatorAddress: string;
  counterpartyAddress: string;
  total: number;
  asset: Asset;
  statusKey: StatusKey;
  milestones: Milestone[];
  // Which deployed NuanceEscrow instance backs this escrow, if any — only
  // an escrow with this set has a real fund_escrow()/release_milestone()
  // to call; most escrows today are still off-chain (null).
  contractAddress?: string | null;
  // Set once the creator's real fund_escrow transaction has been sent —
  // hides the "Fund Escrow" action once present. See lib/api.ts's
  // ApiEscrow.funded_tx_hash for the full caveat on what this does and
  // doesn't guarantee.
  fundedTxHash?: string | null;
  // Set once a real cancel_escrow transaction has been sent and
  // acknowledged. See lib/api.ts's ApiEscrow.cancelled_tx_hash.
  cancelledTxHash?: string | null;
}

export interface Prediction {
  id: number;
  question: string;
  category: string;
  yesPrice: number;
  volume: number;
  resolveDate: string;
  resolutionDate?: string;
  aiSummary: string;
  statusKey?: string;
  outcome?: string | null;
  resolutionReasoning?: string | null;
  resolvedAt?: string | null;
  positions?: Position[];
  // Which deployed NuancePredictionMarket instance backs this market, if
  // any — null for almost every market today. Only markets with this set
  // have a real claim_winnings() to call (an off-chain "Won $X" figure is
  // notional bookkeeping, not a real stake to pull out).
  contractAddress?: string | null;
  chainStatus?: import("@/lib/chain-status").ChainStatus;
  resolutionTriggerTxHash?: string | null;
}

export interface Position {
  id?: number;
  side: "yes" | "no";
  amount: number;
  payout?: number | null;
  status?: string;
}

export interface DisputeMessage {
  id: number;
  disputeId: number;
  senderAddress: string;
  content: string;
  createdAt: string;
}

export interface DisputeEvidence {
  id: number;
  disputeId: number;
  submitterAddress: string;
  description: string;
  link?: string | null;
  createdAt: string;
}

export interface Dispute {
  id: number;
  escrowId: number;
  openedByAddress: string;
  counterpartyAddress: string;
  issue: string;
  amount: number;
  statusKey: StatusKey;
  chainStatus?: import("@/lib/chain-status").ChainStatus;
  onChainTxHash?: string | null;
  // NuanceDisputeCourt's own numeric id for this dispute — null until
  // services/genlayer_indexer.py's resolve_pending_dispute_ids matches
  // the filing tx (an on-chain-filed dispute can be "linked" per
  // chainStatus before this resolves). Evidence can't be added on-chain
  // (genlayer-write-client.ts's addEvidenceOnChain) until this is set —
  // there's no id to call add_evidence with otherwise.
  onChainDisputeId?: number | null;
  // The arbitrator's own stated ruling text — set automatically the
  // instant a real verdict lands (services/consensus.py's
  // _apply_verdict_to_state, called from BOTH the off-chain
  // run_consensus path and the on-chain indexer's adjudicate_dispute
  // sync). Non-null here means this dispute is already resolved, even
  // if no live ConsensusJob is being polled for it — see
  // nuance-app.tsx's disputeVerdict for why that distinction matters.
  ruling?: string | null;
  resolvedAt?: string | null;
  messages?: DisputeMessage[];
  evidence?: DisputeEvidence[];
}

export interface DisputeVerdict {
  label: string;
  approved: boolean;
  reasoning: string;
}

export interface Proposal {
  id: number;
  title: string;
  summary: string;
  category: string;
  status: "Active" | "Closed";
  rawStatus: "active" | "passed" | "rejected" | "executed";
  totalFor: number;
  totalAgainst: number;
  totalAbstain: number;
  // For/against as a share of decided ballots (abstains excluded); abstain
  // as a share of turnout. Mirrors backend/app/routers/governance.py::_progress.
  forPct: number;
  againstPct: number;
  abstainPct: number;
  turnoutPct: number;
  quorumThreshold: number;
  passThreshold: number;
  quorumMet: boolean;
  endTime: string;
  // The connected wallet's own vote, if any — null if not voted or not
  // authenticated (not the same as having voted "abstain").
  userVote: "for" | "against" | "abstain" | null;
}

export interface ValidatorDirectoryEntry {
  name: string;
  accuracyPct: number;
  casesJudged: number;
  isActive: boolean;
  lastActiveAt: string | null;
  // Which provider ("gemini" | "anthropic" | "openai" | "heuristic")
  // answered this validator's most recent case. Null if it has none yet,
  // or the case predates this field.
  lastProvider: string | null;
}

export interface AgentDirectoryEntry {
  walletAddress: string;
  category: string;
  casesJudged: number;
  trustScore: number;
}

// GET /agents/{wallet_address}/history — ROADMAP.md Part 4's Real Agent
// Directory "transaction drill-down".
export interface AgentCase {
  consensusJobId: number;
  subjectType: "milestone" | "dispute";
  subjectId: number;
  escrowId: number;
  disputeId: number | null;
  title: string;
  verdictLabel: string | null;
  verdictApproved: boolean | null;
  verdictConfidence: number | null;
  verdictReasoning: string | null;
  completedAt: string | null;
}

// GET /analytics/overview (ROADMAP.md Part 3 5.5). `*Gen` fields are
// numbers here (unlike ApiAnalyticsOverview's strings) — nuance-app.tsx's
// mapAnalytics parses them once at the API boundary, same reasoning as
// every other Decimal-as-string field this app maps on read.
export interface AnalyticsSnapshot {
  tvlOpenEscrowsGen: number;
  openEscrowCount: number;
  disputeResolutionMedianHours: number | null;
  resolvedDisputeCount: number;
  predictionMarketVolumeGen: number;
  predictionMarketCount: number;
  validatorLeaderboard: ValidatorDirectoryEntry[];
  generatedAt: string;
}

export interface EscrowVerdict {
  approved: boolean;
  disputed: boolean;
  label: string;
  // Optional — a live off-chain verdict (services/consensus.py's
  // ConsensusJob.verdict_confidence) and a synthesized on-chain one both
  // have a real number here, but a *persisted off-chain* milestone
  // (reopened after the ConsensusJob that judged it has long since
  // finished being polled — see nuance-app.tsx's escrowVerdict fallback)
  // has no confidence value to fall back to at all; Milestone never
  // stores one. Omitted rather than a fabricated number — consensus-
  // panel.tsx's own ConsensusVerdict.confidence is optional for exactly
  // this reason already.
  confidence?: number;
  reasoning: string;
}

export type WalletStatus = "idle" | "connecting" | "connected";
