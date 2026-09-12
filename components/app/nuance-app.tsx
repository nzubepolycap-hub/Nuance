"use client";

import { useEffect, useRef, useState } from "react";
import { Sidebar } from "@/components/app/sidebar";
import { WalletModal } from "@/components/app/wallet-modal";
import { DashboardView } from "@/components/app/views/dashboard-view";
import { EscrowDetailView } from "@/components/app/views/escrow-detail-view";
import { CreateEscrowView } from "@/components/app/views/create-escrow-view";
import { CreateMarketView } from "@/components/app/views/create-market-view";
import { PredictionsView } from "@/components/app/views/predictions-view";
import { PredictionDetailView } from "@/components/app/views/prediction-detail-view";
import { DisputesView } from "@/components/app/views/disputes-view";
import { DisputeDetailView } from "@/components/app/views/dispute-detail-view";
import { GovernanceView } from "@/components/app/views/governance-view";
import { ValidatorsView } from "@/components/app/views/validators-view";
import { AgentsView } from "@/components/app/views/agents-view";
import { AgentDetailView } from "@/components/app/views/agent-detail-view";
import { AnalyticsView } from "@/components/app/views/analytics-view";
import { SettingsView } from "@/components/app/views/settings-view";
import { useWalletConnection } from "@/components/app/use-wallet-connection";
import { useConsensusPolling } from "@/components/app/use-consensus-polling";
import { activeMilestoneIndex, formatAddress } from "@/components/app/status";
import type { Eip1193Provider } from "@/components/app/eip1193";
import {
  escrowContractAddress,
  milestoneIsOnChain,
  disputeCourtContractAddress,
  predictionContractAddress,
} from "@/lib/chain-config";
import {
  submitDeliverableOnChain,
  fileDisputeOnChain,
  addEvidenceOnChain,
  betOnChain,
  resolveMarketOnChain,
  claimWinningsOnChain,
  fundEscrowOnChain,
  cancelEscrowOnChain,
  describeWriteError,
} from "@/components/app/genlayer-write-client";
import * as api from "@/lib/api";
import type { ApiDispute, ApiEscrow, ApiMilestone } from "@/lib/api";
import type {
  AgentCase,
  AgentDirectoryEntry,
  AnalyticsSnapshot,
  Dispute,
  DisputeVerdict,
  Escrow,
  EscrowVerdict,
  Milestone,
  Position,
  Prediction,
  Proposal,
  ValidatorDirectoryEntry,
  View,
} from "@/components/app/types";

// --- Backend DTO -> UI-shape mapping ---------------------------------
// Backend amounts are Decimal, serialized as strings ("500.00") — convert
// once here rather than scattering Number(...) calls through the views.

function mapMilestone(m: ApiMilestone): Milestone {
  return {
    name: m.name,
    amount: Number(m.amount),
    statusKey: m.status_key,
    criteria: m.criteria,
    chainStatus: m.chain_status,
    onChainTxHash: m.on_chain_tx_hash,
    onChainIndex: m.on_chain_index,
    reasoning: m.reasoning,
    releasedAt: m.released_at,
  };
}

function mapEscrow(e: ApiEscrow): Escrow {
  return {
    id: e.id,
    title: e.title,
    creatorAddress: e.creator_address,
    counterpartyAddress: e.counterparty_address,
    total: Number(e.total),
    asset: {
      id: e.asset.id,
      symbol: e.asset.symbol,
      decimals: e.asset.decimals,
      contractAddress: e.asset.contract_address,
      isNative: e.asset.is_native,
    },
    statusKey: e.status_key,
    milestones: e.milestones.map(mapMilestone),
    contractAddress: e.contract_address,
    fundedTxHash: e.funded_tx_hash,
    cancelledTxHash: e.cancelled_tx_hash,
  };
}

function mapDispute(d: ApiDispute, escrows: Escrow[]): Dispute {
  const linkedEscrow = escrows.find((e) => e.id === d.escrow_id);
  const counterparty = linkedEscrow
    ? d.opened_by_address.toLowerCase() === linkedEscrow.creatorAddress.toLowerCase()
      ? linkedEscrow.counterpartyAddress
      : linkedEscrow.creatorAddress
    : "0x0000000000000000000000000000000000000000";
  return {
    id: d.id,
    escrowId: d.escrow_id,
    openedByAddress: d.opened_by_address,
    counterpartyAddress: counterparty,
    issue: d.issue,
    amount: linkedEscrow?.total ?? 0,
    statusKey: d.status_key,
    chainStatus: d.chain_status,
    onChainTxHash: d.on_chain_tx_hash,
    onChainDisputeId: d.on_chain_dispute_id,
    ruling: d.ruling,
    resolvedAt: d.resolved_at,
    messages: d.messages?.map((m) => ({
      id: m.id,
      disputeId: m.dispute_id,
      senderAddress: m.sender_address,
      content: m.content,
      createdAt: m.created_at,
    })),
    evidence: d.evidence?.map((e) => ({
      id: e.id,
      disputeId: e.dispute_id,
      submitterAddress: e.submitter_address,
      description: e.description,
      link: e.link,
      createdAt: e.created_at,
    })),
  };
}

function mapPrediction(p: api.ApiPrediction): Prediction {
  const dateObj = new Date(p.resolution_date);
  const formattedDate = dateObj.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const yesPositions = p.positions?.filter((pos) => pos.side.toUpperCase() === "YES") || [];
  const totalPosAmount = p.positions?.reduce((sum, pos) => sum + pos.amount, 0) || 0;
  const yesPosAmount = yesPositions.reduce((sum, pos) => sum + pos.amount, 0);
  const yesPrice = totalPosAmount > 0 ? Math.round((yesPosAmount / totalPosAmount) * 100) : 50;

  return {
    id: p.id,
    question: p.title,
    category: p.category,
    yesPrice: Math.max(1, Math.min(99, yesPrice)),
    volume: p.volume,
    resolveDate: formattedDate,
    resolutionDate: p.resolution_date,
    aiSummary: p.description,
    statusKey: p.status_key,
    outcome: p.outcome,
    resolutionReasoning: p.resolution_reasoning,
    resolvedAt: p.resolved_at,
    positions: p.positions?.map((pos) => ({
      id: pos.id,
      side: pos.side.toLowerCase() as "yes" | "no",
      amount: pos.amount,
      payout: pos.payout,
      status: pos.status,
    })) || [],
    contractAddress: p.contract_address,
    chainStatus: p.chain_status,
    resolutionTriggerTxHash: p.resolution_trigger_tx_hash,
  };
}

function mapProposal(p: api.ApiProposal): Proposal {
  return {
    id: p.id,
    title: p.title,
    summary: p.description,
    category: p.category,
    status: p.status === "active" ? "Active" : "Closed",
    rawStatus: p.status,
    totalFor: p.total_for,
    totalAgainst: p.total_against,
    totalAbstain: p.total_abstain,
    forPct: p.for_pct,
    againstPct: p.against_pct,
    abstainPct: p.abstain_pct,
    turnoutPct: p.turnout_pct,
    quorumThreshold: p.quorum_threshold,
    passThreshold: p.pass_threshold,
    quorumMet: p.quorum_met,
    endTime: p.end_time,
    userVote: p.user_vote,
  };
}

function mapValidator(v: api.ApiValidatorStat): ValidatorDirectoryEntry {
  return {
    name: v.name,
    accuracyPct: v.accuracy_pct,
    casesJudged: v.cases_judged,
    isActive: v.is_active,
    lastActiveAt: v.last_active_at,
    lastProvider: v.last_provider,
  };
}

function mapAgent(a: api.ApiAgentStat): AgentDirectoryEntry {
  return {
    walletAddress: a.wallet_address,
    category: a.category,
    casesJudged: a.cases_judged,
    trustScore: a.trust_score,
  };
}

function mapAgentCase(c: api.ApiAgentCase): AgentCase {
  return {
    consensusJobId: c.consensus_job_id,
    subjectType: c.subject_type,
    subjectId: c.subject_id,
    escrowId: c.escrow_id,
    disputeId: c.dispute_id,
    title: c.title,
    verdictLabel: c.verdict_label,
    verdictApproved: c.verdict_approved,
    verdictConfidence: c.verdict_confidence,
    verdictReasoning: c.verdict_reasoning,
    completedAt: c.completed_at,
  };
}

function mapAnalytics(a: api.ApiAnalyticsOverview): AnalyticsSnapshot {
  return {
    // Number(...) here, not a bare cast — tvl_open_escrows_gen/
    // prediction_market_volume_gen arrive as Decimal-as-string (see
    // ApiAnalyticsOverview's own docstring), same reasoning every other
    // Money field in this file already gets `Number(e.total)` treatment
    // (dashboard-view.tsx's totalEscrowed, for one).
    tvlOpenEscrowsGen: Number(a.tvl_open_escrows_gen),
    openEscrowCount: a.open_escrow_count,
    disputeResolutionMedianHours: a.dispute_resolution_median_hours,
    resolvedDisputeCount: a.resolved_dispute_count,
    predictionMarketVolumeGen: Number(a.prediction_market_volume_gen),
    predictionMarketCount: a.prediction_market_count,
    validatorLeaderboard: a.validator_leaderboard.map(mapValidator),
    generatedAt: a.generated_at,
  };
}

// Mirrors the backend's own re-vote rule (routers/governance.py::
// _adjust_tally): back the previous choice's weight out of the running
// totals before adding the new one in, rather than stacking a second
// ballot on top. turnoutPct/quorumMet aren't recomputed here — they depend
// on the total eligible-voter count, which the frontend doesn't have — so
// they're left at their last server-known value until castVote() resolves
// and mapProposal() overwrites this whole object with the real thing.
function applyOptimisticVote(proposal: Proposal, choice: "For" | "Against"): Proposal {
  const newChoice = choice === "For" ? "for" : "against";
  let totalFor = proposal.totalFor;
  let totalAgainst = proposal.totalAgainst;
  const totalAbstain = proposal.totalAbstain;

  if (proposal.userVote === "for") totalFor -= 1;
  else if (proposal.userVote === "against") totalAgainst -= 1;
  if (newChoice === "for") totalFor += 1;
  else totalAgainst += 1;

  const decided = totalFor + totalAgainst;
  const round1 = (n: number) => Math.round(n * 10) / 10;

  return {
    ...proposal,
    totalFor,
    totalAgainst,
    userVote: newChoice,
    forPct: decided ? round1((100 * totalFor) / decided) : 0,
    againstPct: decided ? round1((100 * totalAgainst) / decided) : 0,
    abstainPct: totalFor + totalAgainst + totalAbstain
      ? round1((100 * totalAbstain) / (totalFor + totalAgainst + totalAbstain))
      : 0,
  };
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-lg border border-negative/35 bg-negative/12 px-3 py-2 text-xs text-negative-text">
      {message}
    </div>
  );
}

// Same shape as ErrorBanner, "info" tone (status.ts's in_progress badge
// already uses this exact pairing) — for a successful, non-final notice
// like an on-chain submission, not a failure.
function InfoBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-lg border border-info/35 bg-info/12 px-3 py-2 text-xs text-info-text">
      {message}
    </div>
  );
}

function ErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-[14px] border border-negative/35 bg-negative/10 p-6 text-center">
      <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-negative/20 text-negative-text font-bold">
        !
      </div>
      <div className="font-semibold text-negative-text text-[15px]">Failed to fetch backend data</div>
      <p className="mt-1 text-xs text-fg-meta max-w-md mx-auto">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 cursor-pointer rounded-lg border border-border-6 bg-chip-hover px-4 py-2 text-xs font-semibold transition-colors hover:bg-chip-hover-2"
        >
          ↻ Retry Connection
        </button>
      )}
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-4 py-4 animate-pulse">
      <div className="h-9 w-48 rounded-lg bg-surface-2" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="h-24 rounded-[14px] bg-surface-2" />
        <div className="h-24 rounded-[14px] bg-surface-2" />
        <div className="h-24 rounded-[14px] bg-surface-2" />
      </div>
      <div className="py-8 text-center text-xs text-fg-meta">{label}</div>
    </div>
  );
}

function WalletAuthGuard({ onConnect }: { onConnect: () => void }) {
  return (
    <div
      style={{ animation: "fadeUp 0.3s ease" }}
      className="flex flex-col items-center justify-center rounded-[20px] border border-border-2 bg-surface-1 px-8 py-20 text-center shadow-lg"
    >
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border-4 bg-surface-2 text-3xl">
        🔒
      </div>
      <div className="font-display text-2xl font-bold text-fg">
        Authentication Required
      </div>
      <p className="mt-2.5 max-w-md text-sm text-fg-dim-2">
        🔒 Connect your wallet to view your secure dashboard and disputes.
      </p>
      <button
        onClick={onConnect}
        className="mt-6 cursor-pointer rounded-xl border border-border-6 bg-chip-hover px-6 py-3 text-sm font-semibold transition-all hover:bg-chip-hover-2 hover:border-border-7"
      >
        Connect Wallet
      </button>
    </div>
  );
}

export function NuanceApp() {
  // Navigation ------------------------------------------------------------
  const [view, setView] = useState<View>("dashboard");

  // Escrows -----------------------------------------------------------------
  const [escrows, setEscrows] = useState<Escrow[]>([]);
  const [escrowsLoading, setEscrowsLoading] = useState(true);
  const [escrowsError, setEscrowsError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deliverableText, setDeliverableText] = useState("");
  // escrow id -> its most recently submitted consensus job id, so
  // reopening an escrow resumes polling that job instead of losing it.
  const [escrowJobIds, setEscrowJobIds] = useState<Record<number, string>>({});
  const [activeEscrowJobId, setActiveEscrowJobId] = useState<string | null>(null);
  const [escrowActionError, setEscrowActionError] = useState<string | null>(null);
  // Set once a deliverable has actually been signed and sent on-chain
  // (see submitDeliverable below) — distinct from escrowActionError:
  // this is a successful, informational notice, not a failure. Cleared
  // whenever a different escrow is opened.
  const [onChainSubmitNotice, setOnChainSubmitNotice] = useState<string | null>(null);
  const [onChainSubmitPending, setOnChainSubmitPending] = useState(false);
  const [escalatePending, setEscalatePending] = useState(false);
  // True while a real, payable NuanceEscrow.fund_escrow transaction is
  // mid-flight (wallet signing prompt / RPC round-trip) — see fundEscrow
  // below.
  const [isFundingEscrow, setIsFundingEscrow] = useState(false);
  // True while a real NuanceEscrow.cancel_escrow transaction is
  // mid-flight — see cancelEscrow below.
  const [isCancellingEscrow, setIsCancellingEscrow] = useState(false);
  // Escrow id being polled for a real GenVM validator verdict after an
  // on-chain submit_deliverable, or null when idle — see the effect
  // below and submitDeliverable's on-chain branch. Added 2026-09-08: a
  // live test found the result only ever showing up after a manual page
  // refresh + wallet reconnect, since nothing was re-fetching this
  // escrow after the ack. services/genlayer_indexer.py already polls
  // the chain server-side every ~15s; this just re-checks its result
  // client-side until it lands, instead of making the user do that by hand.
  const [pollingEscrowId, setPollingEscrowId] = useState<number | null>(null);
  // Which milestone (DB id) to watch, and its status_key at the moment
  // polling started — refs, not state, since setting them is always
  // immediately followed by setPollingEscrowId in the same handler, and
  // the polling effect below only needs to read their current value once
  // when it starts, not re-run if they change.
  const watchedMilestoneIdRef = useRef<number | null>(null);
  const watchedMilestoneStatusRef = useRef<string | null>(null);
  // Same idea as pollingEscrowId, for a dispute awaiting a real ruling
  // (off-chain ConsensusJob or on-chain adjudicate_dispute) — see the
  // polling effect below and openDispute/escalateToDisputeCourt, which
  // both set this whenever the dispute being opened/created is still
  // unresolved ("disputed" — StatusKey's own "still open" state).
  const [pollingDisputeId, setPollingDisputeId] = useState<number | null>(null);
  const watchedDisputeStatusRef = useRef<string | null>(null);

  const [formTitle, setFormTitle] = useState("");
  const [formCounterparty, setFormCounterparty] = useState("");
  const [formAmount, setFormAmount] = useState("");
  const [formCriteria, setFormCriteria] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  // Create-market form (2026-09-12 rebrand) — separate state from the
  // escrow create-form above on purpose, same reasoning every other
  // action in this file gets its own error/pending state rather than
  // sharing one: the two forms can be mid-fill independently, and a
  // failure in one must never surface on the other's screen.
  const [formMarketTitle, setFormMarketTitle] = useState("");
  const [formMarketCategory, setFormMarketCategory] = useState("");
  const [formMarketResolutionDate, setFormMarketResolutionDate] = useState("");
  const [formMarketResolutionSourceUrl, setFormMarketResolutionSourceUrl] = useState("");
  const [formMarketDescription, setFormMarketDescription] = useState("");
  const [createMarketError, setCreateMarketError] = useState<string | null>(null);
  // Shown on the predictions list after a successful create — the new
  // market itself won't appear there yet (starts "pending_review",
  // hidden until deploy_prediction_contract actually links it), so
  // without this the list would look like nothing happened.
  const [createMarketNotice, setCreateMarketNotice] = useState<string | null>(null);

  // Prediction markets ------------------------------------------------------
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [predictionsLoading, setPredictionsLoading] = useState(true);
  const [predictionsError, setPredictionsError] = useState<string | null>(null);
  const [selectedPredictionId, setSelectedPredictionId] = useState<
    number | null
  >(null);
  // Milli-GEN (1000 = 1 GEN) — one of BET_AMOUNTS_MILLI_GEN's fixed
  // quick-pick presets (0.5/1/2/3 GEN), never free-typed. See
  // prediction-detail-view.tsx's own quick-pick buttons.
  const [betAmountMilliGen, setBetAmountMilliGen] = useState<number | null>(null);
  const [betSide, setBetSide] = useState<"yes" | "no" | null>(null);
  const [positions, setPositions] = useState<Record<number, Position>>({});
  const [isBetting, setIsBetting] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isClaiming, setIsClaiming] = useState(false);
  // Per-session only — this app has no read call yet for "has this
  // wallet already called claim_winnings on this market" (the contract's
  // own `claimed` map isn't queried from the frontend today), so this
  // just hides the button immediately after a successful claim in this
  // browser session rather than tracking it durably.
  const [claimedPredictionIds, setClaimedPredictionIds] = useState<Set<number>>(new Set());
  const [bettingError, setBettingError] = useState<string | null>(null);

  // Disputes ------------------------------------------------------------
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [disputesLoading, setDisputesLoading] = useState(true);
  const [disputesError, setDisputesError] = useState<string | null>(null);

  const [selectedDisputeId, setSelectedDisputeId] = useState<number | null>(
    null
  );
  const [evidenceText, setEvidenceText] = useState("");
  // Lifted up here 2026-09-08, matching escrows' own deliverableText
  // pattern — dispute-detail-view.tsx used to own this form's state
  // AND call api.submitEvidence directly, which is exactly why it could
  // never route on-chain: only this file has wallet/contract access.
  const [evidenceLink, setEvidenceLink] = useState("");
  const [isSubmittingEvidence, setIsSubmittingEvidence] = useState(false);
  const [disputeJobIds, setDisputeJobIds] = useState<Record<number, string>>(
    {}
  );
  const [activeDisputeJobId, setActiveDisputeJobId] = useState<string | null>(
    null
  );
  const [disputeActionError, setDisputeActionError] = useState<string | null>(
    null
  );

  // Governance --------------------------------------------------------------
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(true);
  const [proposalsError, setProposalsError] = useState<string | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [pendingVoteId, setPendingVoteId] = useState<number | null>(null);

  const [validators, setValidators] = useState<ValidatorDirectoryEntry[]>([]);
  const [validatorsLoading, setValidatorsLoading] = useState(true);
  const [validatorsError, setValidatorsError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentDirectoryEntry[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  // Agent drill-down (ROADMAP.md Part 4) — fetched lazily per agent on
  // open, not as part of loadData's own bulk load: unlike escrows/
  // disputes/predictions, there's no reason to fetch every agent's full
  // case history before anyone's actually looked at one.
  const [selectedAgentAddress, setSelectedAgentAddress] = useState<string | null>(null);
  const [agentCases, setAgentCases] = useState<AgentCase[]>([]);
  const [agentCasesLoading, setAgentCasesLoading] = useState(false);
  const [agentCasesError, setAgentCasesError] = useState<string | null>(null);

  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  // Settings ------------------------------------------------------------
  const [notifyOn, setNotifyOn] = useState(true);
  const [autoEscalateOn, setAutoEscalateOn] = useState(false);

  // Wallet ------------------------------------------------------------
  const wallet = useWalletConnection();
  const [showWalletModal, setShowWalletModal] = useState(false);

  // Live consensus polling — stage/verdict now come exclusively from the
  // backend rather than a local timer chain.
  const escrowConsensus = useConsensusPolling(activeEscrowJobId);
  const disputeConsensus = useConsensusPolling(activeDisputeJobId);

  // Initial data load — loads escrows, disputes, and predictions from backend.
  const loadData = async () => {
    setEscrowsLoading(true);
    setEscrowsError(null);
    setDisputesLoading(true);
    setDisputesError(null);
    setPredictionsLoading(true);
    setPredictionsError(null);
    setProposalsLoading(true);
    setProposalsError(null);
    setValidatorsLoading(true);
    setValidatorsError(null);
    setAgentsLoading(true);
    setAgentsError(null);
    setAnalyticsLoading(true);
    setAnalyticsError(null);

    let loadedEscrows: Escrow[] = [];
    try {
      const apiEscrows = await api.getEscrows();
      loadedEscrows = apiEscrows.map(mapEscrow);
      setEscrows(loadedEscrows);
    } catch (err) {
      setEscrowsError(errorText(err, "Failed to load escrows from backend."));
    } finally {
      setEscrowsLoading(false);
    }

    try {
      const apiDisputes = await api.getDisputes();
      setDisputes(apiDisputes.map((d) => mapDispute(d, loadedEscrows)));
    } catch (err) {
      setDisputesError(errorText(err, "Failed to load disputes from backend."));
    } finally {
      setDisputesLoading(false);
    }

    try {
      const apiPreds = await api.getPredictions();
      const mappedPreds = apiPreds.map(mapPrediction);
      setPredictions(mappedPreds);

      // Restore user positions if wallet is already connected
      if (wallet.address) {
        const userAddr = wallet.address.toLowerCase();
        const userPositions: Record<number, Position> = {};
        apiPreds.forEach((pred) => {
          const userPos = pred.positions?.filter(
            (pos) => pos.wallet_address.toLowerCase() === userAddr
          );
          if (userPos && userPos.length > 0) {
            const lastPos = userPos[userPos.length - 1];
            userPositions[pred.id] = {
              id: lastPos.id,
              side: lastPos.side.toLowerCase() as "yes" | "no",
              amount: userPos.reduce((sum, p) => sum + p.amount, 0),
              payout: userPos.reduce((sum, p) => sum + (p.payout || 0), 0),
              status: lastPos.status,
            };
          }
        });
        setPositions(userPositions);
      }
    } catch (err) {
      setPredictionsError(errorText(err, "Failed to load predictions from backend."));
    } finally {
      setPredictionsLoading(false);
    }

    try {
      const apiProposals = await api.getProposals();
      setProposals(apiProposals.map(mapProposal));
    } catch (err) {
      setProposalsError(errorText(err, "Failed to load proposals from backend."));
    } finally {
      setProposalsLoading(false);
    }

    try {
      const apiValidators = await api.getValidators();
      setValidators(apiValidators.map(mapValidator));
    } catch (err) {
      setValidatorsError(errorText(err, "Failed to load validators from backend."));
    } finally {
      setValidatorsLoading(false);
    }

    try {
      const apiAgents = await api.getAgents();
      setAgents(apiAgents.map(mapAgent));
    } catch (err) {
      setAgentsError(errorText(err, "Failed to load agents from backend."));
    } finally {
      setAgentsLoading(false);
    }

    try {
      const apiAnalytics = await api.getAnalyticsOverview();
      setAnalytics(mapAnalytics(apiAnalytics));
    } catch (err) {
      setAnalyticsError(errorText(err, "Failed to load analytics from backend."));
    } finally {
      setAnalyticsLoading(false);
    }
  };

  // loadData's own first act, on every call, is six synchronous setState
  // calls (reset every *Loading flag to true / every *Error to null)
  // before its first await — react-hooks/set-state-in-effect correctly
  // flags calling it directly here, since that runs those six setState
  // calls as part of this effect's own synchronous execution (real
  // cascading-render risk, not a false positive). queueMicrotask defers
  // the call past that synchronous phase — a true microtask, not a
  // setTimeout(…, 0) macrotask, so there's no perceptible delay before
  // loading actually starts; it just genuinely isn't "synchronously
  // inside the effect" by the time loadData's own setState calls run.
  useEffect(() => {
    queueMicrotask(() => {
      loadData();
    });
  }, []);

  useEffect(() => {
    if (wallet.status === "connected") {
      api.getMe()
        .then((u) => {
          if (u.settings) {
            setNotifyOn(u.settings.notify_on);
            setAutoEscalateOn(u.settings.auto_escalate_on);
          }
        })
        .catch(() => {});
      queueMicrotask(() => {
        loadData();
      });
    } else {
      // Same reasoning as the queueMicrotask calls above — a direct
      // synchronous setState here is exactly what react-hooks/
      // set-state-in-effect flags, even with nothing async involved.
      queueMicrotask(() => {
        setPositions({});
      });
    }
  }, [wallet.status]);

  // Polls GET /escrows/{id} every 5s while pollingEscrowId is set,
  // stopping once the milestone that was being watched actually changes
  // status (a real verdict landed) or after ~5 minutes (real GenVM
  // consensus rounds have been observed taking a few minutes — bail
  // rather than poll forever if something's stuck; the indexer keeps
  // trying server-side regardless, a later manual refresh still picks
  // it up). See pollingEscrowId's own declaration for why this exists.
  useEffect(() => {
    if (pollingEscrowId == null) return;
    const escrowId = pollingEscrowId;
    const watchedMilestoneId = watchedMilestoneIdRef.current;
    const startingStatusKey = watchedMilestoneId != null ? watchedMilestoneStatusRef.current : null;

    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 60; // 60 * 5s = 5 minutes

    async function poll() {
      attempts += 1;
      try {
        const apiEscrow = await api.getEscrow(escrowId);
        if (cancelled) return;
        const updated = mapEscrow(apiEscrow);
        setEscrows((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));

        const watched = apiEscrow.milestones.find((m) => m.id === watchedMilestoneId);
        const resolved =
          watchedMilestoneId == null || (watched && watched.status_key !== startingStatusKey);
        if (resolved) {
          if (!cancelled) setPollingEscrowId(null);
          return;
        }
      } catch (err) {
        console.error("On-chain milestone poll failed:", err);
      }
      if (!cancelled && attempts < MAX_ATTEMPTS) {
        setTimeout(poll, 5000);
      } else if (!cancelled) {
        setPollingEscrowId(null);
      }
    }

    const timeoutId = setTimeout(poll, 5000);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [pollingEscrowId]);

  // Same mechanism as the escrow-polling effect above, for a dispute
  // awaiting a real ruling (off-chain ConsensusJob or on-chain
  // adjudicate_dispute — services/genlayer_indexer.py's sync). See
  // pollingDisputeId's own declaration for why this exists.
  //
  // `escrows` deliberately left out of the deps array (react-hooks/
  // exhaustive-deps warns) — it's only used inside mapDispute for a
  // counterparty-address lookup that doesn't meaningfully change during
  // a single poll window; including it would restart this effect (reset
  // the timer/attempt count) every time escrows updates anywhere else in
  // the app, which is disruptive for no real benefit. Same reasoning as
  // this file's own loadData omissions elsewhere.
  useEffect(() => {
    if (pollingDisputeId == null) return;
    const disputeId = pollingDisputeId;
    const startingStatusKey = watchedDisputeStatusRef.current;

    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 60; // 60 * 5s = 5 minutes

    async function poll() {
      attempts += 1;
      try {
        const apiDispute = await api.getDispute(disputeId);
        if (cancelled) return;
        const updated = mapDispute(apiDispute, escrows);
        setDisputes((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));

        if (apiDispute.status_key !== startingStatusKey) {
          if (!cancelled) setPollingDisputeId(null);
          return;
        }
      } catch (err) {
        console.error("Dispute ruling poll failed:", err);
      }
      if (!cancelled && attempts < MAX_ATTEMPTS) {
        setTimeout(poll, 5000);
      } else if (!cancelled) {
        setPollingDisputeId(null);
      }
    }

    const timeoutId = setTimeout(poll, 5000);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [pollingDisputeId]);

  const handleToggleNotify = () => {
    const next = !notifyOn;
    setNotifyOn(next);
    if (wallet.status === "connected") {
      api.updateSettings({ notify_on: next }).catch(() => {});
    }
  };

  const handleToggleAutoEscalate = () => {
    const next = !autoEscalateOn;
    setAutoEscalateOn(next);
    if (wallet.status === "connected") {
      api.updateSettings({ auto_escalate_on: next }).catch(() => {});
    }
  };

  // Escrow handlers -----------------------------------------------------
  function goDashboard() {
    setView("dashboard");
    setSelectedId(null);
    setDeliverableText("");
    setActiveEscrowJobId(null);
    setEscrowActionError(null);
  }
  function openEscrow(id: number) {
    setView("detail");
    setSelectedId(id);
    setDeliverableText("");
    setEscrowActionError(null);
    setOnChainSubmitNotice(null);
    setActiveEscrowJobId(escrowJobIds[id] ?? null);
  }
  async function openAgentDetail(walletAddress: string) {
    setView("agentDetail");
    setSelectedAgentAddress(walletAddress);
    setAgentCases([]);
    setAgentCasesError(null);
    setAgentCasesLoading(true);
    try {
      const history = await api.getAgentHistory(walletAddress);
      setAgentCases(history.map(mapAgentCase));
    } catch (err) {
      setAgentCasesError(errorText(err, "Failed to load this agent's case history."));
    } finally {
      setAgentCasesLoading(false);
    }
  }
  async function submitDeliverable() {
    if (!deliverableText.trim() || selectedId == null) return;
    const escrowId = selectedId;
    setEscrowActionError(null);
    setOnChainSubmitNotice(null);

    // A fresh, authoritative read rather than trusting the already-mapped
    // `escrows` state — that UI-shape mapping (mapEscrow/mapMilestone,
    // above) deliberately drops contract_address/on_chain_index, and this
    // decision (on-chain vs. legacy path) has to be made against real,
    // current linkage, not a stale/simplified copy of it.
    let escrowData: api.ApiEscrow;
    try {
      escrowData = await api.getEscrow(escrowId);
    } catch (err) {
      setEscrowActionError(errorText(err, "Failed to submit deliverable."));
      return;
    }
    const activeMilestone = escrowData.milestones.find((m) => m.status_key !== "approved");
    const contractAddress = escrowContractAddress(escrowData);

    if (contractAddress && activeMilestone && milestoneIsOnChain(escrowData, activeMilestone)) {
      // Wallet-readiness split out from the linkage check on purpose
      // (FIXED 2026-09-11) — this used to be one combined condition, so a
      // linked milestone with no wallet connected fell straight through
      // to the "legacy off-chain" branch below and got a real off-chain
      // LLM verdict for an on-chain item. backend/app/services/
      // consensus.py's ChainUnavailableError guard now rejects that
      // off-chain call outright (503) for exactly this reason — so this
      // has to stop the fallback here too, with a real message instead of
      // a confusing request failure.
      if (!(wallet.status === "connected" && wallet.provider)) {
        setEscrowActionError(
          "This milestone is on-chain — connect your wallet to submit a deliverable for it."
        );
        return;
      }

      // On-chain path: sign and send NuanceEscrow.submit_deliverable
      // directly from this browser via the connected wallet — no LLM call
      // from our own backend, GenVM's validator committee does that
      // judgment on the deployed contract instead (ROADMAP.md 4's whole
      // point). This app never waits for that verdict itself; services/
      // genlayer_indexer.py polls it server-side once the tx hash below
      // is handed to the backend.
      setOnChainSubmitPending(true);
      try {
        const txHash = await submitDeliverableOnChain({
          walletAddress: wallet.address,
          provider: wallet.provider,
          contractAddress,
          milestoneIndex: activeMilestone.on_chain_index as number,
          deliverableText,
          deliverableUrl: "",
        });
        await api.submitDeliverableOnChainAck(escrowId, txHash);
        setDeliverableText("");
        setOnChainSubmitNotice(
          `Submitted on-chain — tx ${txHash.slice(0, 10)}…${txHash.slice(-6)}. ` +
            "GenLayer validators are reviewing it now; this can take a few minutes."
        );
        // Start polling for the real result instead of leaving it to a
        // manual refresh — see pollingEscrowId's own declaration.
        watchedMilestoneIdRef.current = activeMilestone.id;
        watchedMilestoneStatusRef.current = activeMilestone.status_key;
        setPollingEscrowId(escrowId);
      } catch (err) {
        setEscrowActionError(describeWriteError(err));
      } finally {
        setOnChainSubmitPending(false);
      }
      return;
    }

    // Legacy off-chain path — unchanged: the backend's own LLM-validator
    // consensus (services/consensus.py) judges the submission.
    try {
      const submission = await api.submitDeliverable(escrowId, deliverableText);
      setDeliverableText("");
      if (submission.consensus_job_id != null) {
        const jobId = String(submission.consensus_job_id);
        setEscrowJobIds((prev) => ({ ...prev, [escrowId]: jobId }));
        setActiveEscrowJobId(jobId);
      }
    } catch (err) {
      setEscrowActionError(errorText(err, "Failed to submit deliverable."));
    }
  }
  // The "Escalate to Internet Court" button (escrow-detail-view.tsx) —
  // was rendered with no handler at all until POST /escrows/{id}/dispute
  // existed to call. Fires with no form of its own; a default claim gets
  // built from the milestone's AI verdict reasoning (server-side for the
  // off-chain path below; here, client-side, since the on-chain call
  // needs real claim text before any backend round-trip happens at all).
  async function escalateToDisputeCourt() {
    if (selectedId == null) return;
    const escrowId = selectedId;
    setEscrowActionError(null);
    setEscalatePending(true);

    let escrowData: api.ApiEscrow;
    try {
      escrowData = await api.getEscrow(escrowId);
    } catch (err) {
      setEscrowActionError(errorText(err, "Failed to raise a dispute."));
      setEscalatePending(false);
      return;
    }

    // NuanceDisputeCourt is the one global shared registry (lib/
    // chain-config.ts's own header) — its address alone doesn't make a
    // dispute "on-chain capable"; the specific escrow being disputed also
    // needs its own NuanceEscrow instance, since that address is what
    // file_dispute records as escrow_address and what services/
    // genlayer_indexer.py later matches against.
    const disputeCourtAddress = disputeCourtContractAddress();
    const escrowAddress = escrowContractAddress(escrowData);

    if (disputeCourtAddress && escrowAddress) {
      // Wallet-readiness split out from the linkage check on purpose
      // (FIXED 2026-09-11) — same reasoning as submitDeliverable's own
      // fix note above: a linked escrow with no wallet connected used to
      // fall through to the "legacy off-chain" branch below and get a
      // real off-chain LLM ruling on an on-chain dispute.
      // backend/app/services/consensus.py's ChainUnavailableError guard
      // now rejects that off-chain call outright (503), so this has to
      // stop the fallback here too, with a real message.
      if (!(wallet.status === "connected" && wallet.provider)) {
        setEscrowActionError(
          "This escrow is on-chain — connect your wallet to file a dispute for it."
        );
        setEscalatePending(false);
        return;
      }

      // On-chain path: sign and send NuanceDisputeCourt.file_dispute
      // directly from this browser. No ConsensusJob, no run_consensus —
      // GenVM's own validator committee is the jury once adjudicate_dispute
      // is called against the contract (separate action, not wired here).
      const respondent =
        wallet.address.toLowerCase() === escrowData.creator_address.toLowerCase()
          ? escrowData.counterparty_address
          : escrowData.creator_address;
      // escrowVerdict (not the raw escrowConsensus.verdict) — see that
      // value's own fix note: it now covers the on-chain-judged case too,
      // so escalating a real GenVM-disputed milestone carries its actual
      // reasoning instead of falling through to the generic fallback.
      const claimStatement = escrowVerdict?.reasoning
        ? `Escalating ${activeMilestoneOnChain ? "GenVM validator" : "AI"} consensus verdict: ${escrowVerdict.reasoning}`
        : `Escalating escrow #${escrowId} to Dispute Court review.`;

      try {
        const txHash = await fileDisputeOnChain({
          walletAddress: wallet.address,
          provider: wallet.provider,
          disputeCourtAddress,
          escrowAddress,
          respondentAddress: respondent,
          claimStatement,
          evidenceUrl: "",
        });
        const created = await api.raiseDisputeOnChainAck(escrowId, txHash, claimStatement);
        const mapped = mapDispute(created, escrows);
        setDisputes((prev) => [mapped, ...prev]);
        openDispute(created.id);
        // Explicit, authoritative override — openDispute's own lookup
        // reads the (still-stale, this same tick) `disputes` state, which
        // doesn't have this brand-new dispute yet. `created` is fresh.
        watchedDisputeStatusRef.current = created.status_key;
        setPollingDisputeId(created.id);
      } catch (err) {
        setEscrowActionError(describeWriteError(err));
      } finally {
        setEscalatePending(false);
      }
      return;
    }

    // Legacy off-chain path — unchanged: the backend judges via its own
    // AI-validator consensus, same as an escalated dispute always has.
    try {
      const created = await api.raiseDispute(escrowId);
      const mapped = mapDispute(created, escrows);
      setDisputes((prev) => [mapped, ...prev]);
      if (created.consensus_job_id != null) {
        setDisputeJobIds((prev) => ({ ...prev, [created.id]: String(created.consensus_job_id) }));
      }
      openDispute(created.id);
      // Same override as the on-chain branch above — belt-and-suspenders
      // here too: the off-chain path's own ConsensusJob polling
      // (activeDisputeJobId) is the primary mechanism, but this covers
      // the same edge case if that job somehow finishes/gets missed
      // before polling picks it up.
      watchedDisputeStatusRef.current = created.status_key;
      setPollingDisputeId(created.id);
    } catch (err) {
      setEscrowActionError(errorText(err, "Failed to raise a dispute."));
    } finally {
      setEscalatePending(false);
    }
  }
  async function releasePayment() {
    if (selectedId == null) return;
    const escrowId = selectedId;
    setEscrowActionError(null);
    try {
      const updated = mapEscrow(await api.releaseMilestone(escrowId));
      setEscrows((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
      setActiveEscrowJobId(null);
      setDeliverableText("");
    } catch (err) {
      setEscrowActionError(errorText(err, "Failed to release payment."));
    }
  }
  // The "Fund Escrow" action (escrow-detail-view.tsx) — a real, payable
  // NuanceEscrow.fund_escrow transaction, signed by the connected wallet.
  // Only shown/usable once auto-deploy has linked a contract_address (see
  // services/genlayer_deploy.py's deploy_escrow_contract, a background
  // task kicked off when the escrow is first created) and only meaningful
  // for the escrow's own creator — the contract itself enforces that
  // restriction, this handler doesn't duplicate the check client-side.
  async function fundEscrow() {
    if (selectedId == null || isFundingEscrow) return;
    if (wallet.status !== "connected" || !wallet.provider) {
      setEscrowActionError("Connect your wallet to fund this escrow.");
      return;
    }
    const escrowId = selectedId;
    setEscrowActionError(null);
    setIsFundingEscrow(true);

    let escrowData: api.ApiEscrow;
    try {
      escrowData = await api.getEscrow(escrowId);
    } catch (err) {
      setEscrowActionError(errorText(err, "Failed to fund escrow."));
      setIsFundingEscrow(false);
      return;
    }
    // CRITICAL — added 2026-09-08 after this exact gap let a wrong
    // wallet sign a real fund_escrow call that then reverted, but GenVM
    // doesn't refund a payable call's attached value on revert (see
    // contracts/nuance_escrow.py's fund_escrow docstring — the same
    // mechanism that caused the original fund-loss incident). The
    // contract's own creator check is real enforcement, but it runs
    // AFTER the GEN has already left the wallet — this check has to
    // happen client-side, before ever calling fundEscrowOnChain, to
    // actually prevent the loss rather than just reject it too late.
    if (wallet.address.toLowerCase() !== escrowData.creator_address.toLowerCase()) {
      setEscrowActionError(
        "Only the escrow creator's wallet can fund this escrow — switch wallets first. " +
          "(Signing this from any other wallet would still send real GEN and lose it — the contract rejects the call, but doesn't refund the value.)"
      );
      setIsFundingEscrow(false);
      return;
    }
    const contractAddress = escrowContractAddress(escrowData);
    if (!contractAddress) {
      setEscrowActionError(
        "This escrow isn't linked to a deployed contract yet — funding isn't available until auto-deploy finishes."
      );
      setIsFundingEscrow(false);
      return;
    }

    try {
      const txHash = await fundEscrowOnChain({
        walletAddress: wallet.address,
        provider: wallet.provider,
        contractAddress,
        amountGen: escrowData.total,
      });
      const updated = mapEscrow(await api.fundEscrowOnChainAck(escrowId, txHash));
      setEscrows((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    } catch (err) {
      setEscrowActionError(describeWriteError(err));
    } finally {
      setIsFundingEscrow(false);
    }
  }
  // The "Cancel Escrow" action (escrow-detail-view.tsx) — a real
  // NuanceEscrow.cancel_escrow transaction, signed by the connected
  // wallet. The contract refunds whatever's locked back to the creator
  // as part of that same transaction (see that method's own contract-
  // side docstring) — nothing further to do here to receive it. Only
  // meaningful for the creator and only while no milestone has been
  // approved yet — the contract itself enforces both, this handler
  // doesn't duplicate the checks client-side.
  async function cancelEscrow() {
    if (selectedId == null || isCancellingEscrow) return;
    if (wallet.status !== "connected" || !wallet.provider) {
      setEscrowActionError("Connect your wallet to cancel this escrow.");
      return;
    }
    const escrowId = selectedId;
    setEscrowActionError(null);
    setIsCancellingEscrow(true);

    let escrowData: api.ApiEscrow;
    try {
      escrowData = await api.getEscrow(escrowId);
    } catch (err) {
      setEscrowActionError(errorText(err, "Failed to cancel escrow."));
      setIsCancellingEscrow(false);
      return;
    }
    // Not a fund-loss risk here (cancel_escrow sends no value), but same
    // principle as fundEscrow's own check: don't let a wrong wallet pay
    // gas to sign a transaction that's guaranteed to be rejected.
    if (wallet.address.toLowerCase() !== escrowData.creator_address.toLowerCase()) {
      setEscrowActionError("Only the escrow creator's wallet can cancel this escrow — switch wallets first.");
      setIsCancellingEscrow(false);
      return;
    }
    const contractAddress = escrowContractAddress(escrowData);
    if (!contractAddress) {
      setEscrowActionError(
        "This escrow isn't linked to a deployed contract — nothing on-chain to cancel."
      );
      setIsCancellingEscrow(false);
      return;
    }

    try {
      const txHash = await cancelEscrowOnChain({
        walletAddress: wallet.address,
        provider: wallet.provider,
        contractAddress,
      });
      const updated = mapEscrow(await api.cancelEscrowOnChainAck(escrowId, txHash));
      setEscrows((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    } catch (err) {
      setEscrowActionError(describeWriteError(err));
    } finally {
      setIsCancellingEscrow(false);
    }
  }
  async function submitCreate() {
    if (!formTitle.trim() || !formCounterparty.trim() || !formAmount) return;
    setCreateError(null);
    try {
      const created = mapEscrow(
        await api.createEscrow({
          title: formTitle,
          counterparty_address: formCounterparty,
          total: Number(formAmount) || 0,
          criteria: formCriteria || null,
        })
      );
      setEscrows((prev) => [...prev, created]);
      setView("detail");
      setSelectedId(created.id);
      setActiveEscrowJobId(null);
      setFormTitle("");
      setFormCounterparty("");
      setFormAmount("");
      setFormCriteria("");
      setDeliverableText("");
    } catch (err) {
      setCreateError(errorText(err, "Failed to create escrow."));
    }
  }

  // Prediction market handlers --------------------------------------------
  function goPredictions() {
    setView("predictions");
    setSelectedPredictionId(null);
    setBetAmountMilliGen(null);
    setBetSide(null);
    setBettingError(null);
  }
  function goCreateMarket() {
    setView("createMarket");
    setCreateMarketError(null);
    setCreateMarketNotice(null);
    setFormMarketTitle("");
    setFormMarketCategory("");
    setFormMarketResolutionDate("");
    setFormMarketResolutionSourceUrl("");
    setFormMarketDescription("");
  }
  async function submitCreateMarket() {
    if (
      !formMarketTitle.trim() ||
      !formMarketCategory.trim() ||
      !formMarketResolutionDate ||
      !formMarketResolutionSourceUrl.trim() ||
      !formMarketDescription.trim()
    ) {
      return;
    }
    setCreateMarketError(null);
    try {
      // <input type="datetime-local"> has no timezone of its own — new
      // Date(...) on that exact string interprets it in the browser's
      // local zone, and .toISOString() below converts that to a real UTC
      // instant, matching what PredictionCreate's resolution_date expects.
      const resolutionDateIso = new Date(formMarketResolutionDate).toISOString();
      await api.createPrediction({
        title: formMarketTitle,
        description: formMarketDescription,
        category: formMarketCategory,
        resolution_date: resolutionDateIso,
        resolution_source_url: formMarketResolutionSourceUrl,
      });
      setCreateMarketNotice(
        "Market created — deploying on-chain now (usually a few minutes). " +
          "It'll appear here once the GenVM contract is live."
      );
      setView("predictions");
    } catch (err) {
      setCreateMarketError(errorText(err, "Failed to create market."));
    }
  }
  function openPrediction(id: number) {
    setView("predictionDetail");
    setSelectedPredictionId(id);
    setBetAmountMilliGen(null);
    setBetSide(null);
    setBettingError(null);
  }
  async function placeBet() {
    if (betAmountMilliGen == null || !betSide || selectedPredictionId == null || isBetting) return;
    const amountMilliGen = betAmountMilliGen;

    setIsBetting(true);
    setBettingError(null);
    const predictionId = selectedPredictionId;

    // A fresh, authoritative read rather than trusting the already-loaded
    // `predictions` state — same reasoning submitDeliverable/
    // escalateToDisputeCourt already give: this decision (on-chain vs.
    // legacy) has to be made against real, current linkage.
    let predictionData: api.ApiPrediction;
    try {
      predictionData = await api.getPrediction(predictionId);
    } catch (err) {
      setBettingError(errorText(err, "Failed to place bet."));
      setIsBetting(false);
      return;
    }
    const contractAddress = predictionContractAddress(predictionData);

    if (contractAddress) {
      // Wallet-readiness split out from the linkage check on purpose
      // (FIXED 2026-09-11) — a linked market with no wallet connected
      // used to fall through to the "legacy off-chain" branch below and
      // mirror a notional, no-real-stake-behind-it bet onto it.
      // backend/app/services/consensus.py's ChainUnavailableError guard
      // (reused by routers/predictions.py's place_bet for the same
      // "never silently substitute for a linked item" reason) now rejects
      // that off-chain call outright (503), so this has to stop the
      // fallback here too, with a real message.
      if (!(wallet.status === "connected" && wallet.provider)) {
        setBettingError("This market is on-chain — connect your wallet to place a bet.");
        setIsBetting(false);
        return;
      }

      // On-chain path: sign and send NuancePredictionMarket.bet directly
      // from this browser via the connected wallet — a real, payable
      // transaction (see betOnChain's own comment on the milli-GEN-to-wei
      // conversion), unlike every other on-chain write this app makes.
      try {
        const txHash = await betOnChain({
          walletAddress: wallet.address,
          provider: wallet.provider,
          contractAddress,
          outcome: betSide.toUpperCase() as "YES" | "NO",
          amountMilliGen,
        });
        const updatedApi = await api.placeBetOnChainAck(predictionId, txHash, betSide, amountMilliGen);
        const updatedPred = mapPrediction(updatedApi);
        setPredictions((prev) => prev.map((p) => (p.id === updatedPred.id ? updatedPred : p)));
        setPositions((prev) => ({
          ...prev,
          [predictionId]: {
            side: betSide,
            amount: (prev[predictionId]?.amount || 0) + amountMilliGen,
          },
        }));
        setBetAmountMilliGen(null);
      } catch (err) {
        setBettingError(describeWriteError(err));
      } finally {
        setIsBetting(false);
      }
      return;
    }

    // Legacy off-chain path — unchanged.
    try {
      const updatedApi = await api.placeBet(predictionId, betSide, amountMilliGen);
      const updatedPred = mapPrediction(updatedApi);
      setPredictions((prev) => prev.map((p) => (p.id === updatedPred.id ? updatedPred : p)));
      setPositions((prev) => ({
        ...prev,
        [predictionId]: {
          side: betSide,
          amount: (prev[predictionId]?.amount || 0) + amountMilliGen,
        },
      }));
      setBetAmountMilliGen(null);
    } catch (err) {
      setBettingError(errorText(err, "Failed to place bet. Ensure wallet is connected."));
    } finally {
      setIsBetting(false);
    }
  }

  async function resolveMarket() {
    if (selectedPredictionId == null || isResolving) return;
    setIsResolving(true);
    setBettingError(null);
    const predictionId = selectedPredictionId;

    let predictionData: api.ApiPrediction;
    try {
      predictionData = await api.getPrediction(predictionId);
    } catch (err) {
      setBettingError(errorText(err, "Failed to resolve prediction market."));
      setIsResolving(false);
      return;
    }
    const contractAddress = predictionContractAddress(predictionData);

    if (contractAddress) {
      // Wallet-readiness split out from the linkage check on purpose
      // (FIXED 2026-09-11) — a linked market with no wallet connected used
      // to fall through to the "legacy off-chain" branch below, which
      // routers/predictions.py's resolve_prediction now refuses outright
      // (503/ChainUnavailableError) for a linked market — it resolves
      // on-chain automatically via services/genlayer_indexer.py's
      // trigger_pending_market_resolutions instead. See
      // backend/app/services/consensus.py's ChainUnavailableError
      // docstring.
      if (!(wallet.status === "connected" && wallet.provider)) {
        setBettingError(
          "This market is on-chain — connect your wallet to trigger resolution manually, " +
            "or wait for it to resolve automatically once its cutoff passes."
        );
        setIsResolving(false);
        return;
      }

      // On-chain path: sign and send NuancePredictionMarket.resolve_market
      // directly. Manual/optional — services/genlayer_indexer.py's
      // trigger_pending_market_resolutions already does this automatically
      // once the cutoff passes; this just lets someone trigger it sooner
      // rather than wait for the indexer's own poll cycle. No local state
      // to update yet either way: resolution isn't instant (GenVM
      // validators still have to decide), so there's nothing real to show
      // until a later refetch picks up the actual outcome.
      try {
        await resolveMarketOnChain({
          walletAddress: wallet.address,
          provider: wallet.provider,
          contractAddress,
        });
      } catch (err) {
        setBettingError(describeWriteError(err));
      } finally {
        setIsResolving(false);
      }
      return;
    }

    // Legacy off-chain path — unchanged.
    try {
      const updatedApi = await api.resolvePrediction(predictionId);
      const updatedPred = mapPrediction(updatedApi);
      setPredictions((prev) => prev.map((p) => (p.id === updatedPred.id ? updatedPred : p)));

      if (wallet.address) {
        const userAddr = wallet.address.toLowerCase();
        const userPos = updatedApi.positions?.filter(
          (pos) => pos.wallet_address.toLowerCase() === userAddr
        );
        if (userPos && userPos.length > 0) {
          const lastPos = userPos[userPos.length - 1];
          setPositions((prev) => ({
            ...prev,
            [predictionId]: {
              id: lastPos.id,
              side: lastPos.side.toLowerCase() as "yes" | "no",
              amount: userPos.reduce((sum, p) => sum + p.amount, 0),
              payout: userPos.reduce((sum, p) => sum + (p.payout || 0), 0),
              status: lastPos.status,
            },
          }));
        }
      }
    } catch (err) {
      setBettingError(errorText(err, "Failed to resolve prediction market."));
    } finally {
      setIsResolving(false);
    }
  }

  async function claimWinnings() {
    if (selectedPredictionId == null || isClaiming) return;
    if (wallet.status !== "connected" || !wallet.provider) {
      setBettingError("Connect your wallet to claim winnings.");
      return;
    }
    const predictionId = selectedPredictionId;
    setIsClaiming(true);
    setBettingError(null);

    let predictionData: api.ApiPrediction;
    try {
      predictionData = await api.getPrediction(predictionId);
    } catch (err) {
      setBettingError(errorText(err, "Failed to claim winnings."));
      setIsClaiming(false);
      return;
    }
    const contractAddress = predictionContractAddress(predictionData);
    if (!contractAddress) {
      // Off-chain "Won $X" is a notional figure computed by
      // services/payout.py — there's no real stake to pull out for a
      // market that was never linked to a deployed contract.
      setBettingError("This market's payout is off-chain and settles automatically.");
      setIsClaiming(false);
      return;
    }

    try {
      await claimWinningsOnChain({
        walletAddress: wallet.address,
        provider: wallet.provider,
        contractAddress,
      });
      setClaimedPredictionIds((prev) => new Set(prev).add(predictionId));
    } catch (err) {
      setBettingError(describeWriteError(err));
    } finally {
      setIsClaiming(false);
    }
  }

  // Dispute handlers --------------------------------------------------------
  function goDisputes() {
    setView("disputes");
    setSelectedDisputeId(null);
    setEvidenceText("");
    setEvidenceLink("");
    setActiveDisputeJobId(null);
    setDisputeActionError(null);
  }
  function openDispute(id: number) {
    setView("disputeDetail");
    setSelectedDisputeId(id);
    setEvidenceText("");
    setEvidenceLink("");
    setDisputeActionError(null);
    setActiveDisputeJobId(disputeJobIds[id] ?? null);
    // Start polling if this dispute is still open ("disputed" — see
    // pollingDisputeId's own declaration). Looks up the already-loaded
    // `disputes` list — fine for navigating to an existing dispute, but
    // NOT authoritative for one just created this same tick (that state
    // update hasn't committed yet); escalateToDisputeCourt below sets
    // this explicitly, right after calling openDispute, using the fresh
    // data it already has instead of relying on this lookup.
    const existing = disputes.find((d) => d.id === id);
    if (existing && existing.statusKey === "disputed") {
      watchedDisputeStatusRef.current = existing.statusKey;
      setPollingDisputeId(id);
    }
  }
  // REWRITTEN 2026-09-08 — this used to always call the off-chain
  // api.submitEvidence, full stop, no matter how the dispute was filed.
  // That's the actual bug a live test caught: an on-chain-filed dispute
  // got its ruling silently produced by Nuance's own off-chain fallback
  // instead of real GenVM validators the moment evidence was submitted,
  // with nothing in the UI making the swap visible. See
  // contracts/nuance_dispute_court.py's add_evidence and
  // genlayer-write-client.ts's addEvidenceOnChain, both added to close
  // this for real rather than just describe it.
  async function submitEvidence() {
    if (!evidenceText.trim() || selectedDisputeId == null || isSubmittingEvidence) return;
    const disputeId = selectedDisputeId;
    setDisputeActionError(null);

    let disputeData: api.ApiDispute;
    try {
      disputeData = await api.getDispute(disputeId);
    } catch (err) {
      setDisputeActionError(errorText(err, "Failed to submit evidence."));
      return;
    }
    const disputeCourtAddress = disputeCourtContractAddress();
    const isOnChainFiled = disputeData.chain_status !== "legacy_offchain";

    if (isOnChainFiled) {
      // Wallet/config-readiness split out from the linkage check on
      // purpose (FIXED 2026-09-11) — an on-chain-filed dispute with no
      // wallet connected used to fall through to the "legacy off-chain"
      // branch below, which is exactly the bug this function's own header
      // comment describes fixing once already. backend/app/services/
      // consensus.py's ChainUnavailableError guard now rejects that
      // off-chain call outright (503) for an on-chain-filed dispute, so
      // this has to stop the fallback here too, with a real message.
      if (!disputeCourtAddress || !(wallet.status === "connected" && wallet.provider)) {
        setDisputeActionError(
          "This dispute was filed on-chain — connect your wallet to submit evidence for it."
        );
        return;
      }
      // On-chain path — requires the real numeric dispute id, which only
      // exists once services/genlayer_indexer.py's resolve_pending_
      // dispute_ids has matched the filing tx. Refuse rather than
      // silently fall back off-chain (the exact bug this rewrite fixes)
      // if it hasn't resolved yet.
      if (disputeData.on_chain_dispute_id == null) {
        setDisputeActionError(
          "This dispute was filed on-chain, but hasn't finished linking to its on-chain id yet " +
            "(usually a few minutes) — try again shortly rather than submitting off-chain evidence for it."
        );
        return;
      }
      // The contract's own add_evidence only accepts a URL — there's
      // nowhere for free-text-only evidence to go on-chain.
      if (!evidenceLink.trim()) {
        setDisputeActionError(
          "This dispute is on-chain — evidence needs a real link (URL) for validators to fetch. " +
            "A description with no link can't be submitted on-chain."
        );
        return;
      }

      setIsSubmittingEvidence(true);
      try {
        const txHash = await addEvidenceOnChain({
          walletAddress: wallet.address,
          provider: wallet.provider,
          disputeCourtAddress,
          onChainDisputeId: disputeData.on_chain_dispute_id,
          evidenceUrl: evidenceLink.trim(),
        });
        await api.submitEvidenceOnChainAck(disputeId, txHash, evidenceLink.trim());
        setEvidenceText("");
        setEvidenceLink("");
      } catch (err) {
        setDisputeActionError(describeWriteError(err));
      } finally {
        setIsSubmittingEvidence(false);
      }
      return;
    }

    // Legacy off-chain path — unchanged: Nuance's own AI review judges it.
    setIsSubmittingEvidence(true);
    try {
      const submission = await api.submitEvidence(disputeId, evidenceText, evidenceLink.trim() || null);
      setEvidenceText("");
      setEvidenceLink("");
      if (submission.consensus_job_id != null) {
        const jobId = String(submission.consensus_job_id);
        setDisputeJobIds((prev) => ({ ...prev, [disputeId]: jobId }));
        setActiveDisputeJobId(jobId);
      }
    } catch (err) {
      setDisputeActionError(errorText(err, "Failed to submit evidence."));
    } finally {
      setIsSubmittingEvidence(false);
    }
  }
  // enforceRuling() removed 2026-09-08 — see dispute-detail-view.tsx's
  // consensusVerdict comment for the full account: POST /disputes/{id}/
  // enforce always 400s in real use, since services/consensus.py's
  // _apply_verdict_to_state already resolves the dispute (off-chain or
  // on-chain, same function) before this button could ever become
  // clickable. Nothing replaced it — there was nothing left to enforce.

  // Governance handlers -----------------------------------------------------
  async function vote(id: number, choice: "For" | "Against") {
    const target = proposals.find((p) => p.id === id);
    if (!target || target.status !== "Active" || pendingVoteId != null) return;

    setVoteError(null);
    setPendingVoteId(id);
    const previous = target;
    // Optimistic update — reflected immediately, reconciled with the
    // server's authoritative tally below (or rolled back on failure).
    setProposals((prev) => prev.map((p) => (p.id === id ? applyOptimisticVote(p, choice) : p)));

    try {
      const updated = await api.castVote(id, choice);
      setProposals((prev) => prev.map((p) => (p.id === id ? mapProposal(updated) : p)));
    } catch (err) {
      setProposals((prev) => prev.map((p) => (p.id === id ? previous : p)));
      setVoteError(errorText(err, "Failed to cast vote."));
    } finally {
      setPendingVoteId(null);
    }
  }

  // Wallet handlers -----------------------------------------------------
  async function selectWallet(provider: Eip1193Provider, name: string) {
    const connected = await wallet.connect(provider, name);
    // Close only on success — a rejection/error should leave the modal open
    // with the error message visible, not silently vanish.
    if (connected) setShowWalletModal(false);
  }

  // Derived view data -----------------------------------------------------
  const selectedEscrow = escrows.find((e) => e.id === selectedId) ?? null;
  const selectedPrediction =
    predictions.find((p) => p.id === selectedPredictionId) ?? null;
  const selectedDispute =
    disputes.find((d) => d.id === selectedDisputeId) ?? null;

  // CRITICAL fix, 2026-09-08: escrowVerdict used to come ONLY from
  // escrowConsensus (useConsensusPolling against a ConsensusJob id) —
  // which only exists for the lifetime of the browser session that
  // triggered it (escrowJobIds is plain React state, never persisted).
  // A milestone judged in an *earlier* session — on-chain, or off-chain
  // and simply reopened after its own ConsensusJob finished being
  // polled — had nothing to fall back to, so this stayed null forever:
  // "Release Payment" and "Escalate to Internet Court" (both driven
  // entirely by this value, via ConsensusPanel) never appeared, no
  // matter what the real recorded verdict was. First found live for the
  // on-chain case 2026-09-08 (fixed then); found again 2026-09-10 for
  // the off-chain case specifically — reopening ANY already-disputed
  // off-chain milestone after a page refresh left "Escalate to Internet
  // Court" permanently unreachable, since the fallback below only ever
  // checked activeMilestoneOnChain. Falls back to synthesizing a verdict
  // straight from the active milestone's own persisted statusKey/
  // reasoning when there's no ConsensusJob to poll — on-chain or off.
  const activeMilestone = selectedEscrow
    ? selectedEscrow.milestones[activeMilestoneIndex(selectedEscrow.milestones)]
    : null;
  const activeMilestoneOnChain =
    Boolean(selectedEscrow?.contractAddress) && activeMilestone?.onChainIndex != null;
  // Both added 2026-09-08 — found live: "Release Payment" and "Escalate
  // to Internet Court" kept showing (and, for release, kept genuinely
  // failing — see routers/escrows.py's _releasable_milestone fix) even
  // after the underlying action had already been taken. Neither the
  // verdict object nor the milestone's own statusKey change once
  // released/escalated (statusKey stays "approved"/"disputed" either
  // way), so these need their own separate signals.
  const milestoneAlreadyReleased = activeMilestone?.releasedAt != null;
  const existingDisputeForEscrow = selectedEscrow
    ? disputes.find((d) => d.escrowId === selectedEscrow.id) ?? null
    : null;

  const escrowVerdict: EscrowVerdict | null = escrowConsensus.verdict
    ? {
        approved: escrowConsensus.verdict.approved,
        disputed: !escrowConsensus.verdict.approved,
        label: escrowConsensus.verdict.approved
          ? "Consensus: Approved"
          : "Consensus: Disputed",
        confidence: escrowConsensus.verdict.confidence,
        reasoning: escrowConsensus.verdict.reasoning,
      }
    : activeMilestone && (activeMilestone.statusKey === "approved" || activeMilestone.statusKey === "disputed")
      ? {
          approved: activeMilestone.statusKey === "approved",
          disputed: activeMilestone.statusKey === "disputed",
          label: activeMilestoneOnChain
            ? activeMilestone.statusKey === "approved"
              ? "GenVM Consensus: Approved"
              : "GenVM Consensus: Disputed"
            : activeMilestone.statusKey === "approved"
              ? "Consensus: Approved"
              : "Consensus: Disputed",
          // GenVM doesn't expose a numeric confidence the way the
          // off-chain ensemble's per-provider vote average does, and a
          // *persisted* off-chain verdict has no confidence value to
          // fall back to either (Milestone never stores one — only the
          // ConsensusJob that judged it did, and that job's own record
          // isn't looked up here). Omitted either way, not fabricated —
          // EscrowVerdict.confidence is optional for exactly this.
          confidence: activeMilestoneOnChain ? 100 : undefined,
          reasoning: activeMilestone.reasoning ?? "",
        }
      : null;

  // Same fix as escrowVerdict above, same root cause: disputeConsensus
  // only ever reflects a live ConsensusJob (off-chain path). A dispute
  // ruled on-chain (adjudicate_dispute -> services/genlayer_indexer.py's
  // sync) has its ruling/status_key set directly with no ConsensusJob
  // involved at all — this used to leave the panel stuck on "Awaiting
  // evidence submission…" forever regardless of a real ruling already
  // being recorded. Falls back to the dispute's own persisted ruling/
  // statusKey once there's no live job to poll — also covers simply
  // reopening an already-resolved off-chain dispute later, when its
  // ConsensusJob has long since finished being polled.
  const disputeVerdict: DisputeVerdict | null = disputeConsensus.verdict
    ? {
        label: disputeConsensus.verdict.approved
          ? `Ruling: In favor of ${formatAddress(selectedDispute?.openedByAddress)}`
          : `Ruling: In favor of ${formatAddress(selectedDispute?.counterpartyAddress)}`,
        approved: disputeConsensus.verdict.approved,
        reasoning: disputeConsensus.verdict.reasoning,
      }
    : selectedDispute &&
        (selectedDispute.statusKey === "approved" || selectedDispute.statusKey === "rejected")
      ? {
          label:
            selectedDispute.statusKey === "approved"
              ? `Ruling: In favor of ${formatAddress(selectedDispute.openedByAddress)}`
              : `Ruling: In favor of ${formatAddress(selectedDispute.counterpartyAddress)}`,
          approved: selectedDispute.statusKey === "approved",
          reasoning: selectedDispute.ruling ?? "",
        }
      : null;

  return (
    <div className="flex min-h-screen">
      <Sidebar
        view={view}
        onNavigate={(key) => {
          if (key === "dashboard") goDashboard();
          else if (key === "predictions") goPredictions();
          else if (key === "disputes") goDisputes();
          else setView(key as View);
        }}
        walletStatus={wallet.status}
        walletAddress={wallet.addressShort}
        walletBalance={wallet.balance}
        isWrongNetwork={wallet.isWrongNetwork}
        walletError={showWalletModal ? null : wallet.error}
        onOpenWalletModal={() => setShowWalletModal(true)}
        onDisconnect={wallet.disconnect}
        onSwitchNetwork={wallet.switchNetwork}
      />

      {showWalletModal && (
        <WalletModal
          onClose={() => setShowWalletModal(false)}
          onSelect={selectWallet}
          connecting={wallet.status === "connecting"}
          error={wallet.error}
        />
      )}

      <div className="max-w-[1200px] flex-1 p-10 py-10 sm:px-14">
        {view === "dashboard" &&
          (wallet.status !== "connected" ? (
            <WalletAuthGuard onConnect={() => setShowWalletModal(true)} />
          ) : escrowsLoading ? (
            <LoadingState label="Loading escrows from backend…" />
          ) : escrowsError ? (
            <ErrorCard message={escrowsError} onRetry={loadData} />
          ) : (
            <DashboardView
              escrows={escrows}
              onOpenCreate={() => setView("create")}
              onOpenEscrow={openEscrow}
            />
          ))}

        {view === "detail" &&
          (wallet.status !== "connected" ? (
            <WalletAuthGuard onConnect={() => setShowWalletModal(true)} />
          ) : selectedEscrow ? (
            <>
              {escrowActionError && <ErrorBanner message={escrowActionError} />}
              {onChainSubmitNotice && <InfoBanner message={onChainSubmitNotice} />}
              <EscrowDetailView
                escrow={selectedEscrow}
                stage={escrowConsensus.stage}
                deliverableText={deliverableText}
                verdict={escrowVerdict}
                onBack={goDashboard}
                onDeliverableChange={setDeliverableText}
                onSubmitDeliverable={submitDeliverable}
                onReleasePayment={releasePayment}
                onEscalate={escalateToDisputeCourt}
                onFundEscrow={fundEscrow}
                onCancelEscrow={cancelEscrow}
                submitDisabled={onChainSubmitPending}
                escalateDisabled={escalatePending}
                fundingDisabled={isFundingEscrow}
                cancellingDisabled={isCancellingEscrow}
                connectedWalletAddress={wallet.status === "connected" ? wallet.address : null}
                milestoneReleased={milestoneAlreadyReleased}
                existingDisputeId={existingDisputeForEscrow?.id ?? null}
                onViewExistingDispute={
                  existingDisputeForEscrow ? () => openDispute(existingDisputeForEscrow.id) : undefined
                }
              />
            </>
          ) : null)}

        {view === "create" &&
          (wallet.status !== "connected" ? (
            <WalletAuthGuard onConnect={() => setShowWalletModal(true)} />
          ) : (
            <>
              {createError && <ErrorBanner message={createError} />}
              <CreateEscrowView
                formTitle={formTitle}
                formCounterparty={formCounterparty}
                formAmount={formAmount}
                formCriteria={formCriteria}
                onTitleChange={setFormTitle}
                onCounterpartyChange={setFormCounterparty}
                onAmountChange={setFormAmount}
                onCriteriaChange={setFormCriteria}
                onCancel={goDashboard}
                onSubmit={submitCreate}
              />
            </>
          ))}

        {view === "createMarket" &&
          (wallet.status !== "connected" ? (
            <WalletAuthGuard onConnect={() => setShowWalletModal(true)} />
          ) : (
            <>
              {createMarketError && <ErrorBanner message={createMarketError} />}
              <CreateMarketView
                formTitle={formMarketTitle}
                formCategory={formMarketCategory}
                formResolutionDate={formMarketResolutionDate}
                formResolutionSourceUrl={formMarketResolutionSourceUrl}
                formDescription={formMarketDescription}
                onTitleChange={setFormMarketTitle}
                onCategoryChange={setFormMarketCategory}
                onResolutionDateChange={setFormMarketResolutionDate}
                onResolutionSourceUrlChange={setFormMarketResolutionSourceUrl}
                onDescriptionChange={setFormMarketDescription}
                onCancel={goPredictions}
                onSubmit={submitCreateMarket}
              />
            </>
          ))}

        {view === "predictions" &&
          (predictionsLoading ? (
            <LoadingState label="Loading prediction markets from backend…" />
          ) : predictionsError ? (
            <ErrorCard message={predictionsError} onRetry={loadData} />
          ) : (
            <PredictionsView
              predictions={predictions}
              onOpen={openPrediction}
              onOpenCreate={goCreateMarket}
              notice={createMarketNotice}
            />
          ))}

        {view === "predictionDetail" && selectedPrediction && (
          <PredictionDetailView
            prediction={selectedPrediction}
            betAmountMilliGen={betAmountMilliGen}
            betSide={betSide}
            position={positions[selectedPrediction.id] ?? null}
            isBetting={isBetting}
            isResolving={isResolving}
            isClaiming={isClaiming}
            hasClaimed={claimedPredictionIds.has(selectedPrediction.id)}
            bettingError={bettingError}
            onBack={goPredictions}
            onSelectYes={() => setBetSide("yes")}
            onSelectNo={() => setBetSide("no")}
            onSelectAmount={setBetAmountMilliGen}
            onPlaceBet={placeBet}
            onResolveMarket={resolveMarket}
            onClaimWinnings={claimWinnings}
          />
        )}

        {view === "disputes" &&
          (wallet.status !== "connected" ? (
            <WalletAuthGuard onConnect={() => setShowWalletModal(true)} />
          ) : disputesLoading ? (
            <LoadingState label="Loading disputes from backend…" />
          ) : disputesError ? (
            <ErrorCard message={disputesError} onRetry={loadData} />
          ) : (
            <DisputesView disputes={disputes} onOpen={openDispute} />
          ))}

        {view === "disputeDetail" &&
          (wallet.status !== "connected" ? (
            <WalletAuthGuard onConnect={() => setShowWalletModal(true)} />
          ) : selectedDispute ? (
            <>
              {disputeActionError && <ErrorBanner message={disputeActionError} />}
              <DisputeDetailView
                dispute={selectedDispute}
                stage={disputeConsensus.stage}
                verdict={disputeVerdict}
                currentWalletAddress={wallet.address}
                onBack={goDisputes}
                evidenceDesc={evidenceText}
                evidenceLink={evidenceLink}
                onEvidenceDescChange={setEvidenceText}
                onEvidenceLinkChange={setEvidenceLink}
                onSubmitEvidence={submitEvidence}
                submittingEvidence={isSubmittingEvidence}
              />
            </>
          ) : null)}

        {view === "governance" &&
          (proposalsLoading ? (
            <LoadingState label="Loading proposals from backend…" />
          ) : proposalsError ? (
            <ErrorCard message={proposalsError} onRetry={loadData} />
          ) : (
            <>
              {voteError && <ErrorBanner message={voteError} />}
              <GovernanceView
                proposals={proposals}
                walletConnected={wallet.status === "connected"}
                pendingVoteId={pendingVoteId}
                onVote={vote}
              />
            </>
          ))}

        {view === "validators" &&
          (validatorsLoading ? (
            <LoadingState label="Loading validator network from backend…" />
          ) : validatorsError ? (
            <ErrorCard message={validatorsError} onRetry={loadData} />
          ) : (
            <ValidatorsView validators={validators} />
          ))}

        {view === "agents" &&
          (agentsLoading ? (
            <LoadingState label="Loading agent directory from backend…" />
          ) : agentsError ? (
            <ErrorCard message={agentsError} onRetry={loadData} />
          ) : (
            <AgentsView agents={agents} onOpenAgent={openAgentDetail} />
          ))}

        {view === "agentDetail" &&
          selectedAgentAddress &&
          (() => {
            const agent =
              agents.find((a) => a.walletAddress === selectedAgentAddress) ?? {
                walletAddress: selectedAgentAddress,
                category: "Unknown",
                casesJudged: agentCases.length,
                trustScore: 0,
              };
            return (
              <AgentDetailView
                agent={agent}
                cases={agentCases}
                casesLoading={agentCasesLoading}
                casesError={agentCasesError}
                onBack={() => setView("agents")}
                onOpenEscrow={openEscrow}
                onOpenDispute={openDispute}
              />
            );
          })()}

        {view === "analytics" &&
          (analyticsLoading ? (
            <LoadingState label="Loading analytics from backend…" />
          ) : analyticsError || !analytics ? (
            <ErrorCard message={analyticsError ?? "No analytics data."} onRetry={loadData} />
          ) : (
            <AnalyticsView analytics={analytics} />
          ))}

        {view === "settings" && (
          <SettingsView
            notifyOn={notifyOn}
            autoEscalateOn={autoEscalateOn}
            onToggleNotify={handleToggleNotify}
            onToggleAutoEscalate={handleToggleAutoEscalate}
          />
        )}
      </div>
    </div>
  );
}
