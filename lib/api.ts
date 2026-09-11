// Strongly-typed fetch wrapper around the Nuance FastAPI backend.
//
// Owns: the JWT (localStorage), attaching it to every request, reacting to
// a 401 by dropping it and notifying whoever registered as the
// "unauthorized" handler (see setUnauthorizedHandler — wired up by
// use-wallet-connection.ts so an expired/invalid session also disconnects
// the wallet), and the raw backend DTO shapes (snake_case, matching
// backend/app/schemas.py exactly). UI-shape mapping into this app's own
// Escrow/Dispute/Milestone types happens in nuance-app.tsx, not here.

import type { StatusKey } from "@/components/app/types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8010";

const TOKEN_STORAGE_KEY = "nuance_token";

// --- Token storage -----------------------------------------------------

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // Private-browsing / storage-disabled contexts can throw on access.
    return null;
  }
}

function setToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Session just won't persist — not fatal.
  }
}

function clearStoredToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // see setToken
  }
}

/** True once a JWT has been stored by a successful verifySignature(). */
export function hasAuthToken(): boolean {
  return getToken() !== null;
}

/** Explicit drop — called on wallet disconnect so no stale session survives it. */
export function clearAuthToken(): void {
  clearStoredToken();
}

// --- Unauthorized handling ------------------------------------------------

type UnauthorizedListener = () => void;
let unauthorizedListener: UnauthorizedListener | null = null;

/** Registered once by useWalletConnection so a 401 from anywhere can drop
 * the wallet's connected state — this module has no React state of its own. */
export function setUnauthorizedHandler(listener: UnauthorizedListener | null): void {
  unauthorizedListener = listener;
}

// --- Core request wrapper --------------------------------------------------

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// FastAPI error bodies are either {"detail": "message"} or, on a 422
// validation failure, {"detail": [{"msg": "...", ...}, ...]}.
function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) =>
          d && typeof d === "object" && "msg" in d
            ? String((d as { msg: unknown }).msg)
            : String(d)
        )
        .join("; ");
    }
  }
  return fallback;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    clearStoredToken();
    unauthorizedListener?.();
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON error body (e.g. a proxy's HTML error page) — fall through.
    }
    throw new ApiError(
      res.status,
      errorMessage(body, res.statusText || `Request failed (${res.status})`)
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --- Backend DTOs (snake_case — mirrors backend/app/schemas.py) -----------

// Mirrors backend/app/enums.py's ChainStatus — see that enum's own
// docstring for why this vocabulary has to match lib/chain-status.ts's
// ChainStatus exactly rather than be re-derived here.
export type ApiChainStatus = "legacy_offchain" | "processing" | "decided" | "finalized" | "canceled";

export interface ApiMilestone {
  id: number;
  name: string;
  amount: string; // Decimal, serialized as a string (e.g. "500.00")
  status_key: StatusKey;
  criteria: string;
  order_index: number;
  // Null until this milestone is linked to an index inside its escrow's
  // deployed NuanceEscrow contract — see lib/chain-config.ts's
  // milestoneIsOnChain(). Not the same number as `id`/`order_index`.
  on_chain_index: number | null;
  chain_status: ApiChainStatus;
  on_chain_tx_hash: string | null;
  // The validator committee's own stated reasoning for approving/
  // disputing this milestone — real GenVM validator text once linked
  // on-chain, or the off-chain ensemble's text otherwise. See
  // models/core.py's Milestone.reasoning for why this didn't exist
  // before (silently discarded for on-chain milestones specifically).
  reasoning: string | null;
  // Set once this milestone has actually been paid out via POST
  // /escrows/{id}/release — see models/core.py's Milestone.released_at.
  // Null means either not yet approved, or approved but not released.
  released_at: string | null;
}

// ROADMAP.md Part 4 6.2's multi-token collateral — the settlement
// currency an escrow's total/milestone amounts are denominated in. Every
// escrow has one (server_default points existing rows at native GEN, id
// 1 — see models/core.py::Asset's own docstring), so this is never null.
export interface ApiAsset {
  id: number;
  symbol: string;
  decimals: number;
  contract_address: string | null;
  is_native: boolean;
}

export interface ApiEscrow {
  id: number;
  creator_address: string;
  counterparty_address: string;
  title: string;
  total: string;
  asset: ApiAsset;
  status_key: StatusKey;
  created_at: string;
  milestones: ApiMilestone[];
  // Which deployed NuanceEscrow instance backs this escrow — null for
  // almost every escrow today (see lib/chain-config.ts's own header on
  // why there's no single global escrow address to fall back to).
  contract_address: string | null;
  // The tx hash of the creator's real, payable NuanceEscrow.fund_escrow
  // call, once sent — null means either not linked to a contract yet, or
  // linked but not funded yet. See models/core.py's Escrow.funded_tx_hash
  // for why this is only a UI convenience, not the source of truth for
  // whether the contract itself is actually funded.
  funded_tx_hash: string | null;
  // Set once a real cancel_escrow() transaction has been sent and
  // acknowledged — see models/core.py's Escrow.cancelled_tx_hash.
  cancelled_tx_hash: string | null;
}

export interface ApiDeliverableSubmission {
  id: number;
  milestone_id: number;
  wallet: string;
  text: string;
  submitted_at: string;
  consensus_job_id: number | null;
}

export interface ApiDisputeMessage {
  id: number;
  dispute_id: number;
  sender_address: string;
  content: string;
  created_at: string;
}

export interface ApiDisputeEvidence {
  id: number;
  dispute_id: number;
  submitter_address: string;
  description: string;
  link: string | null;
  created_at: string;
  consensus_job_id: number | null;
}

export interface ApiDispute {
  id: number;
  escrow_id: number;
  milestone_id: number | null;
  opened_by_address: string;
  issue: string;
  status_key: StatusKey;
  ruling: string | null;
  enforced_by: string | null;
  created_at: string;
  resolved_at: string | null;
  messages: ApiDisputeMessage[];
  evidence: ApiDisputeEvidence[];
  // Which entry in NuanceDisputeCourt's shared registry this dispute maps
  // to — null until services/genlayer_indexer.py's resolve_pending_
  // dispute_ids matches it (see lib/chain-config.ts's own header on why
  // there's no single global "the" dispute id to fall back to).
  on_chain_dispute_id: number | null;
  chain_status: ApiChainStatus;
  on_chain_tx_hash: string | null;
}

// The response shape POST /escrows/{id}/dispute specifically returns —
// ApiDispute plus the queued ConsensusJob's id, same reasoning
// ApiDeliverableSubmission/ApiDisputeEvidence already carry one: the
// frontend needs it back synchronously to start polling GET /consensus/{id}
// right away, not GET /disputes/{id} first to go find it.
export interface ApiDisputeCreateResponse extends ApiDispute {
  consensus_job_id: number | null;
}

export interface ApiValidatorResult {
  name: string;
  vote: "approve" | "dispute";
  confidence: number;
  reasoning: string;
}

export interface ApiConsensusVerdict {
  label: string;
  approved: boolean;
  confidence: number;
  reasoning: string;
}

export interface ApiConsensusStatus {
  stage: number;
  validator_results: ApiValidatorResult[] | null;
  verdict: ApiConsensusVerdict | null;
}

export interface ApiPredictionPosition {
  id: number;
  prediction_id: number;
  wallet_address: string;
  side: string;
  amount: number;
  payout?: number | null;
  status?: string;
  created_at: string;
}

export interface ApiPrediction {
  id: number;
  title: string;
  description: string;
  category: string;
  resolution_date: string;
  volume: number;
  status_key: string;
  outcome: string | null;
  resolution_reasoning?: string | null;
  created_at: string;
  resolved_at?: string | null;
  positions: ApiPredictionPosition[];
  // Which deployed NuancePredictionMarket instance backs this market —
  // null for almost every market today (see lib/chain-config.ts's own
  // header). Once set, betting/resolution route on-chain.
  contract_address: string | null;
  chain_status: ApiChainStatus;
  resolution_trigger_tx_hash?: string | null;
}

export type ApiVoteChoice = "for" | "against" | "abstain";
export type ApiProposalStatus = "active" | "passed" | "rejected" | "executed";

export interface ApiVote {
  id: number;
  proposal_id: number;
  voter_address: string;
  choice: ApiVoteChoice;
  voting_power: number;
  created_at: string;
  updated_at: string;
}

export interface ApiProposal {
  id: number;
  title: string;
  description: string;
  category: string;
  proposer_address: string;
  status: ApiProposalStatus;
  start_time: string;
  end_time: string;
  quorum_threshold: number;
  pass_threshold: number;
  total_for: number;
  total_against: number;
  total_abstain: number;
  created_at: string;
  // Computed fresh by the backend on every read — see
  // backend/app/schemas/governance.py's ProposalRead docstring.
  turnout_pct: number;
  for_pct: number;
  against_pct: number;
  abstain_pct: number;
  quorum_met: boolean;
  // The requesting wallet's own vote, if any and if authenticated. Absent
  // (null) on an anonymous request — not the same as "voted abstain".
  user_vote: ApiVoteChoice | null;
}

export interface ApiProposalDetail extends ApiProposal {
  votes: ApiVote[];
}

export interface CreateProposalPayload {
  title: string;
  description: string;
  category?: string;
  voting_period_days?: number;
  quorum_threshold?: number;
  pass_threshold?: number;
}

export interface ApiValidatorStat {
  name: string;
  cases_judged: number;
  accuracy_pct: number;
  is_active: boolean;
  last_active_at: string | null;
  last_provider: string | null;
}

export interface ApiAgentStat {
  wallet_address: string;
  category: string;
  cases_judged: number;
  trust_score: number;
}

// GET /agents/{wallet_address}/history (ROADMAP.md Part 4's Real Agent
// Directory "transaction drill-down") — one entry per judged case behind
// an agent's aggregate trust_score above.
export interface ApiAgentCase {
  consensus_job_id: number;
  subject_type: "milestone" | "dispute";
  subject_id: number;
  escrow_id: number;
  dispute_id: number | null;
  title: string;
  verdict_label: string | null;
  verdict_approved: boolean | null;
  verdict_confidence: number | null;
  verdict_reasoning: string | null;
  completed_at: string | null;
}

// GET /analytics/overview (ROADMAP.md Part 3 5.5) — every *_gen field
// arrives as a JSON string (FastAPI serializes Decimal that way), not a
// number, same reasoning callers already handle for Escrow.total/
// Prediction amounts elsewhere in this file.
export interface ApiAnalyticsOverview {
  tvl_open_escrows_gen: string;
  open_escrow_count: number;
  dispute_resolution_median_hours: number | null;
  resolved_dispute_count: number;
  prediction_market_volume_gen: string;
  prediction_market_count: number;
  validator_leaderboard: ApiValidatorStat[];
  generated_at: string;
}

export interface ApiNonceResponse {
  nonce: string;
  message: string;
}

export interface ApiTokenResponse {
  access_token: string;
  token_type: string;
  wallet_address: string;
}

export interface ApiUserSettings {
  notify_on: boolean;
  auto_escalate_on: boolean;
}

export interface ApiUser {
  wallet_address: string;
  display_name: string | null;
  created_at: string;
  settings?: ApiUserSettings | null;
}

export interface CreateEscrowPayload {
  title: string;
  counterparty_address: string;
  total: number;
  criteria?: string | null;
}

export interface EnforceDisputePayload {
  approved: boolean;
  ruling?: string | null;
}

// --- Auth -----------------------------------------------------------------

export async function requestNonce(walletAddress: string): Promise<ApiNonceResponse> {
  return apiFetch<ApiNonceResponse>("/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ wallet_address: walletAddress }),
  });
}

/** Verifies the signed nonce message and stores the returned JWT on success. */
export async function verifySignature(
  walletAddress: string,
  message: string,
  signature: string
): Promise<ApiTokenResponse> {
  const result = await apiFetch<ApiTokenResponse>("/auth/verify", {
    method: "POST",
    body: JSON.stringify({ wallet_address: walletAddress, message, signature }),
  });
  setToken(result.access_token);
  return result;
}

export async function getMe(): Promise<ApiUser> {
  return apiFetch<ApiUser>("/auth/me");
}

export async function updateMe(payload: { display_name?: string | null }): Promise<ApiUser> {
  return apiFetch<ApiUser>("/auth/me", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function updateSettings(payload: {
  notify_on?: boolean;
  auto_escalate_on?: boolean;
}): Promise<ApiUserSettings> {
  return apiFetch<ApiUserSettings>("/auth/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

// --- Escrows ----------------------------------------------------------

export async function getEscrows(): Promise<ApiEscrow[]> {
  return apiFetch<ApiEscrow[]>("/escrows");
}

export async function getEscrow(id: number): Promise<ApiEscrow> {
  return apiFetch<ApiEscrow>(`/escrows/${id}`);
}

export async function createEscrow(payload: CreateEscrowPayload): Promise<ApiEscrow> {
  return apiFetch<ApiEscrow>("/escrows", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function submitDeliverable(
  escrowId: number,
  text: string
): Promise<ApiDeliverableSubmission> {
  return apiFetch<ApiDeliverableSubmission>(`/escrows/${escrowId}/deliverable`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

// The on-chain counterpart: called after components/app/
// genlayer-write-client.ts has already signed and sent a real
// NuanceEscrow.submit_deliverable transaction directly to the chain —
// this just hands the resulting tx hash to the backend so services/
// genlayer_indexer.py has something to poll. No `text` here; the
// deliverable text already lives on-chain (the contract's own storage),
// not in this request.
export async function submitDeliverableOnChainAck(
  escrowId: number,
  txHash: string
): Promise<ApiMilestone> {
  return apiFetch<ApiMilestone>(`/escrows/${escrowId}/deliverable/on-chain`, {
    method: "POST",
    body: JSON.stringify({ tx_hash: txHash }),
  });
}

// The on-chain counterpart: called after components/app/
// genlayer-write-client.ts's fundEscrowOnChain has already signed and sent
// a real, payable NuanceEscrow.fund_escrow transaction — real GEN has
// already left the creator's wallet by the time this fires. This call
// only records the tx hash for the UI (hide the "Fund Escrow" action once
// set); it does not itself move any funds. Only the escrow's own creator
// may call this (enforced server-side, matching fund_escrow's own
// contract-side restriction).
export async function fundEscrowOnChainAck(
  escrowId: number,
  txHash: string
): Promise<ApiEscrow> {
  return apiFetch<ApiEscrow>(`/escrows/${escrowId}/fund/on-chain`, {
    method: "POST",
    body: JSON.stringify({ tx_hash: txHash }),
  });
}

// The on-chain counterpart: called after components/app/
// genlayer-write-client.ts's cancelEscrowOnChain has already signed and
// sent a real NuanceEscrow.cancel_escrow transaction — the contract has
// already refunded whatever was locked back to the creator's wallet by
// the time this fires. This call flips status_key to "cancelled" locally
// (see OnChainCancelAck's own docstring on why that's safe to trust
// immediately, unlike fund/deliverable acks). Only the escrow's own
// creator may call this (enforced server-side, matching cancel_escrow's
// own contract-side restriction).
export async function cancelEscrowOnChainAck(
  escrowId: number,
  txHash: string
): Promise<ApiEscrow> {
  return apiFetch<ApiEscrow>(`/escrows/${escrowId}/cancel/on-chain`, {
    method: "POST",
    body: JSON.stringify({ tx_hash: txHash }),
  });
}

export async function releaseMilestone(escrowId: number): Promise<ApiEscrow> {
  return apiFetch<ApiEscrow>(`/escrows/${escrowId}/release`, { method: "POST" });
}

// Escalates the escrow's active milestone to a formal Dispute Court
// review — the "Escalate to Internet Court" button (escrow-detail-view.tsx)
// fires this with no `issue` of its own; the backend fills in a default
// from the milestone's AI verdict reasoning when omitted.
export async function raiseDispute(
  escrowId: number,
  issue?: string
): Promise<ApiDisputeCreateResponse> {
  return apiFetch<ApiDisputeCreateResponse>(`/escrows/${escrowId}/dispute`, {
    method: "POST",
    body: JSON.stringify(issue ? { issue } : {}),
  });
}

// The on-chain counterpart: called after components/app/
// genlayer-write-client.ts's fileDisputeOnChain has already signed and
// sent a real NuanceDisputeCourt.file_dispute transaction. `issue` here
// MUST be the exact same text passed as that call's claimStatement — the
// backend stores it verbatim, and services/genlayer_indexer.py's
// resolve_pending_dispute_ids matches on exact string equality, not
// fuzzy matching.
export async function raiseDisputeOnChainAck(
  escrowId: number,
  txHash: string,
  issue: string
): Promise<ApiDispute> {
  return apiFetch<ApiDispute>(`/escrows/${escrowId}/dispute/on-chain`, {
    method: "POST",
    body: JSON.stringify({ tx_hash: txHash, issue }),
  });
}

// --- Disputes ---------------------------------------------------------

export async function getDisputes(): Promise<ApiDispute[]> {
  return apiFetch<ApiDispute[]>("/disputes");
}

export async function getDispute(id: number): Promise<ApiDispute> {
  return apiFetch<ApiDispute>(`/disputes/${id}`);
}

export async function getDisputeMessages(disputeId: number): Promise<ApiDisputeMessage[]> {
  return apiFetch<ApiDisputeMessage[]>(`/disputes/${disputeId}/messages`);
}

export async function sendDisputeMessage(
  disputeId: number,
  content: string
): Promise<ApiDisputeMessage> {
  return apiFetch<ApiDisputeMessage>(`/disputes/${disputeId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

export async function getDisputeEvidence(disputeId: number): Promise<ApiDisputeEvidence[]> {
  return apiFetch<ApiDisputeEvidence[]>(`/disputes/${disputeId}/evidence`);
}

export async function submitEvidence(
  disputeId: number,
  description: string,
  link?: string | null
): Promise<ApiDisputeEvidence> {
  return apiFetch<ApiDisputeEvidence>(`/disputes/${disputeId}/evidence`, {
    method: "POST",
    body: JSON.stringify({ description, link: link || null }),
  });
}

// The on-chain counterpart: called after components/app/
// genlayer-write-client.ts's addEvidenceOnChain has already signed and
// sent a real NuanceDisputeCourt.add_evidence transaction. Records a
// local DisputeEvidence row for the UI's evidence list — the real
// judgment happens via adjudicate_dispute on the contract itself, not
// anything queued by this call (unlike submitEvidence above).
export async function submitEvidenceOnChainAck(
  disputeId: number,
  txHash: string,
  evidenceUrl: string
): Promise<ApiDisputeEvidence> {
  return apiFetch<ApiDisputeEvidence>(`/disputes/${disputeId}/evidence/on-chain`, {
    method: "POST",
    body: JSON.stringify({ tx_hash: txHash, evidence_url: evidenceUrl }),
  });
}

export async function enforceRuling(
  disputeId: number,
  payload: EnforceDisputePayload
): Promise<ApiDispute> {
  return apiFetch<ApiDispute>(`/disputes/${disputeId}/enforce`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// --- Consensus --------------------------------------------------------

export async function getConsensusStatus(jobId: number): Promise<ApiConsensusStatus> {
  return apiFetch<ApiConsensusStatus>(`/consensus/${jobId}`);
}

// --- Predictions ------------------------------------------------------

export async function getPredictions(): Promise<ApiPrediction[]> {
  return apiFetch<ApiPrediction[]>("/predictions");
}

export async function getPrediction(id: number): Promise<ApiPrediction> {
  return apiFetch<ApiPrediction>(`/predictions/${id}`);
}

export async function placeBet(
  predictionId: number,
  side: "YES" | "NO" | "yes" | "no",
  amount: number
): Promise<ApiPrediction> {
  return apiFetch<ApiPrediction>(`/predictions/${predictionId}/bet`, {
    method: "POST",
    body: JSON.stringify({ side: side.toUpperCase(), amount }),
  });
}

// The on-chain counterpart: called after components/app/
// genlayer-write-client.ts's betOnChain has already signed and sent a
// real NuancePredictionMarket.bet transaction. side/amount here mirror
// the stake into a PredictionPosition row (the indexer's view-sync
// doesn't track individual bettors' on-chain stakes, only the market's
// own state as a whole — see that endpoint's own docstring).
export async function placeBetOnChainAck(
  predictionId: number,
  txHash: string,
  side: "YES" | "NO" | "yes" | "no",
  amount: number
): Promise<ApiPrediction> {
  return apiFetch<ApiPrediction>(`/predictions/${predictionId}/bet/on-chain`, {
    method: "POST",
    body: JSON.stringify({ tx_hash: txHash, side: side.toUpperCase(), amount }),
  });
}

export async function resolvePrediction(predictionId: number): Promise<ApiPrediction> {
  return apiFetch<ApiPrediction>(`/predictions/${predictionId}/resolve`, {
    method: "POST",
  });
}

// --- Governance ---------------------------------------------------------

export async function getProposals(): Promise<ApiProposal[]> {
  return apiFetch<ApiProposal[]>("/proposals");
}

export async function getProposal(id: number): Promise<ApiProposalDetail> {
  return apiFetch<ApiProposalDetail>(`/proposals/${id}`);
}

export async function createProposal(payload: CreateProposalPayload): Promise<ApiProposal> {
  return apiFetch<ApiProposal>("/proposals", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// `choice` is case-insensitive on the backend (VoteCreate._normalize_choice
// lowercases before validating), so callers can pass "For"/"Against" as-is.
export async function castVote(
  proposalId: number,
  choice: ApiVoteChoice | "For" | "Against" | "Abstain"
): Promise<ApiProposal> {
  return apiFetch<ApiProposal>(`/proposals/${proposalId}/vote`, {
    method: "POST",
    body: JSON.stringify({ choice }),
  });
}

// --- Validators & agents --------------------------------------------------

export async function getValidators(): Promise<ApiValidatorStat[]> {
  return apiFetch<ApiValidatorStat[]>("/validators");
}

export async function getAgents(): Promise<ApiAgentStat[]> {
  return apiFetch<ApiAgentStat[]>("/agents");
}

export async function getAgentHistory(walletAddress: string): Promise<ApiAgentCase[]> {
  return apiFetch<ApiAgentCase[]>(`/agents/${walletAddress}/history`);
}

export async function getAnalyticsOverview(): Promise<ApiAnalyticsOverview> {
  return apiFetch<ApiAnalyticsOverview>("/analytics/overview");
}


