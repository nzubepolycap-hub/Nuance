// Contract-address wiring — deliberately separate from lib/api.ts's
// NEXT_PUBLIC_API_URL (that one always has a working localhost fallback;
// these don't, because there is nothing to fall back to before a real
// contract is deployed and linked — see ROADMAP.md 4.6's SYNC POINT).
//
// Corrected 2026-09-07 (writeContract wiring): the original version of
// this file treated all three contracts as one global NEXT_PUBLIC_*
// address each, "configured" or not for the whole app at once. That's
// only true for NuanceDisputeCourt — a single SHARED REGISTRY (see that
// contract's own header). NuanceEscrow and NuancePredictionMarket are the
// opposite: ONE deployed instance PER escrow / PER market (see
// contracts/nuance_escrow.py and nuance_prediction_market.py, and
// scripts/deploy.ts's own bootstrap-instance caveat) — there is no
// single "the" escrow contract address for the whole app to check
// against. Real per-escrow/per-market addresses come back from the API
// on the row itself (ApiEscrow.contract_address / ApiPrediction.
// contract_address), populated once that row is actually linked to a
// deployed instance — nothing does that yet except services/
// genlayer_indexer.py's --link-demo, which is exactly why every real
// escrow/prediction still routes through the legacy off-chain path today.
//
// Every call site MUST handle `null` — that's the real, current state of
// almost every row in this app, not a hypothetical edge case. Treat a
// null contract address as "route this through the legacy off-chain
// path," exactly like an escrow/dispute created before any cutover.

export const BRADBURY_DISPUTE_COURT_ADDRESS = "0xD140A876aBe1180d2436508a8Ea1b674e4724402" as `0x${string}`;
export const BRADBURY_GOVERNANCE_ADDRESS = "0xF0a2F4c8eF813cF4F8dcc7Bfe94f0E82aF0ED7A7" as `0x${string}`;
export const BRADBURY_VALIDATORS_ADDRESS = "0xBdA1dB02Ff6a1ddF8A306567100dAfbA26570E61" as `0x${string}`;
export const BRADBURY_AGENT_DIRECTORY_ADDRESS = "0x044b000fc9DE64a1c75C1F2531bcFc5Ea627BaA8" as `0x${string}`;
export const BRADBURY_ESCROW_ADDRESS = "0xD397cF79B368a221C84c214725e6c7BC1F29A2FF" as `0x${string}`;
export const BRADBURY_PREDICTION_MARKET_ADDRESS = "0x08149602c5cAaE87beFb0631B5Cf983a944aD67C" as `0x${string}`;

/** NuanceDisputeCourt's one deployed address, or null if it isn't
 * configured yet. Global on purpose — every dispute shares this one
 * registry. */
export function disputeCourtContractAddress(): `0x${string}` | null {
  const raw =
    process.env.NEXT_PUBLIC_DISPUTE_COURT_CONTRACT_ADDRESS?.trim() ||
    BRADBURY_DISPUTE_COURT_ADDRESS;
  return raw ? (raw as `0x${string}`) : null;
}

/** NuanceGovernance's one deployed address, or null. Same "genuinely
 * global, not per-row" reasoning as disputeCourtContractAddress above —
 * see ROADMAP.md 4.4.1's own account of which of the six deployed
 * contracts are real shared registries vs. per-agreement instances. */
export function governanceContractAddress(): `0x${string}` | null {
  const raw =
    process.env.NEXT_PUBLIC_GOVERNANCE_CONTRACT_ADDRESS?.trim() ||
    BRADBURY_GOVERNANCE_ADDRESS;
  return raw ? (raw as `0x${string}`) : null;
}

/** NuanceValidators' deployed address, or null — deployed (ROADMAP.md
 * 4.4.3) but not load-bearing yet: routers/validators.py computes the
 * real validator directory by scanning ConsensusJob history, not by
 * reading this contract. Exposed here purely for app/docs's reference
 * table, honestly labeled as such — see that page for the caveat. */
export function validatorsContractAddress(): `0x${string}` | null {
  const raw =
    process.env.NEXT_PUBLIC_VALIDATORS_CONTRACT_ADDRESS?.trim() ||
    BRADBURY_VALIDATORS_ADDRESS;
  return raw ? (raw as `0x${string}`) : null;
}

/** Same as validatorsContractAddress, for NuanceAgentDirectory —
 * deployed, not yet load-bearing (routers/agents.py computes the real
 * agent directory from ConsensusJob history too). */
export function agentDirectoryContractAddress(): `0x${string}` | null {
  const raw =
    process.env.NEXT_PUBLIC_AGENT_DIRECTORY_CONTRACT_ADDRESS?.trim() ||
    BRADBURY_AGENT_DIRECTORY_ADDRESS;
  return raw ? (raw as `0x${string}`) : null;
}

/** The deployed NuanceEscrow instance backing a specific escrow, or null
 * if that escrow hasn't been linked to one. Per-agreement instance —
 * never fall back to a global bootstrap contract address when null. */
export function escrowContractAddress(
  escrow: { contract_address?: string | null } | null | undefined
): `0x${string}` | null {
  const raw = escrow?.contract_address?.trim();
  return raw ? (raw as `0x${string}`) : null;
}

/** Same idea as escrowContractAddress, for NuancePredictionMarket.
 * Per-market instance — must return null for off-chain markets so the
 * frontend routes them through the off-chain API instead of attempting
 * an on-chain wallet transaction against the bootstrap test market. */
export function predictionContractAddress(
  prediction: { contract_address?: string | null } | null | undefined
): `0x${string}` | null {
  const raw = prediction?.contract_address?.trim();
  return raw ? (raw as `0x${string}`) : null;
}

/** True once this specific milestone is both (a) inside an escrow linked
 * to a deployed NuanceEscrow instance and (b) itself linked to an index
 * inside it (Milestone.on_chain_index — a contract instance holds every
 * milestone for its escrow, addressed by a per-contract index distinct
 * from this app's own milestone id/order_index). Both have to be true —
 * an escrow can be linked before every one of its milestones is. */
export function milestoneIsOnChain(
  escrow: { contract_address?: string | null } | null | undefined,
  milestone: { on_chain_index?: number | null } | null | undefined
): boolean {
  return escrowContractAddress(escrow) !== null && milestone?.on_chain_index != null;
}
