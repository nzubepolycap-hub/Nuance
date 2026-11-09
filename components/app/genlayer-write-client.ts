// Wallet-signed on-chain writes — Part 2, Step 4 (ROADMAP.md 4.6).
//
// Every call here goes straight from this browser to the GenLayer
// contract via the user's own connected wallet — never through the
// backend, never with a private key this app holds (that's scripts/
// deploy.ts's job, server-side, deploying new instances — a completely
// different action from calling a method on one that's already live).
// This file does not wait for the transaction to be accepted/finalized
// either; that's services/genlayer_indexer.py's job, polling server-side.
// The caller (components/app/nuance-app.tsx) only needs the tx hash back,
// to hand to POST /escrows/{id}/deliverable/on-chain so the indexer knows
// to watch it.
//
// --- Verification ---
// createClient's browser-wallet shape (account: the connected address,
// provider: the EIP-1193 provider) is ROADMAP.md 4.6's own documented
// pattern, verified there against the installed genlayer-js@1.1.8 type
// definitions. writeContract's return value specifically — a plain
// 0x-prefixed transaction hash string, not a receipt object, despite the
// installed .d.ts loosely typing it as `Promise<any>` — was confirmed by
// reading the installed package's own compiled source directly
// (node_modules/genlayer-js/dist/index.js): writeContract's doc comment
// there reads "Returns the transaction hash," and it delegates to the
// exact same internal _sendTransaction helper deployContract uses —
// which scripts/deploy.ts already proved, against live Bradbury, resolves
// to a plain hash. Not live-tested from *this* file specifically — doing
// so would mean actually signing and sending a real transaction against
// the live bootstrap contract, a mutating action this file's own author
// (an agent, not the person who'll actually use a wallet here) has no
// business doing unprompted. Re-verify against whatever genlayer-js
// version is installed before trusting this again if it's ever upgraded.

import { createClient, chains } from "genlayer-js";
import { TransactionStatus, type TransactionHash } from "genlayer-js/types";
import { type Eip1193Provider, isEip1193Error } from "@/components/app/eip1193";
import {
  milliGenToWei,
  parseGenToWei,
  GENLAYER_BRADBURY,
  GENLAYER_BRADBURY_ADD_CHAIN_PARAMS,
} from "@/components/app/genlayer-chain";

export interface SubmitDeliverableOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  contractAddress: `0x${string}`;
  milestoneIndex: number;
  deliverableText: string;
  deliverableUrl: string;
}

export interface FileDisputeOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  // NuanceDisputeCourt's own address — the one global shared registry
  // (lib/chain-config.ts's disputeCourtContractAddress()), NOT the
  // escrow's own contract_address. See that contract's header: unlike
  // NuanceEscrow, every dispute across the whole app lives in this one
  // instance.
  disputeCourtAddress: `0x${string}`;
  // The escrow's own deployed NuanceEscrow address — file_dispute's first
  // argument, which the contract stores as escrow_address on the dispute
  // record. This is what services/genlayer_indexer.py's
  // resolve_pending_dispute_ids later matches against.
  escrowAddress: `0x${string}`;
  respondentAddress: string;
  claimStatement: string;
  evidenceUrl: string;
}

/** User-facing message for a failed on-chain submit — same style as
 * use-wallet-connection.ts's describeError, reused rather than
 * duplicated logic (isEip1193Error is the same check), separate function
 * because the messages that make sense here ("rejected the transaction")
 * differ from a connection/signing failure's. */
export function describeWriteError(err: unknown): string {
  if (isEip1193Error(err)) {
    if (err.code === 4001) return "Transaction rejected in wallet.";
    return err.message || "Wallet transaction failed.";
  }
  if (err instanceof Error) return err.message;
  return "Wallet transaction failed.";
}

/** Ensures wallet is on GenLayer Bradbury Testnet (4221) before sending transactions. */
export async function ensureBradburyNetwork(provider: Eip1193Provider): Promise<void> {
  try {
    const chainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
    if (chainIdHex?.toLowerCase() !== GENLAYER_BRADBURY.chainIdHex.toLowerCase()) {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: GENLAYER_BRADBURY.chainIdHex }],
        });
      } catch (switchErr: unknown) {
        if (isEip1193Error(switchErr) && switchErr.code === 4902) {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [GENLAYER_BRADBURY_ADD_CHAIN_PARAMS],
          });
        }
      }
    }
  } catch (err) {
    console.warn("Auto switch to Bradbury network warning:", err);
  }
}

function createWriteClient(walletAddress: string, provider: Eip1193Provider) {
  return createClient({
    chain: chains.testnetBradbury,
    account: walletAddress as `0x${string}`,
    endpoint: "https://rpc-bradbury.genlayer.com",
    // EthereumProvider isn't resolvable from genlayer-js's own installed
    // .d.ts (a real gap in this pre-mainnet SDK's types, confirmed via
    // `tsc --noEmit` on this exact file — not this project's bug to fix)
    // — cast rather than fight a type name the package itself can't
    // resolve. The runtime shape genlayer-js actually needs (a `request`
    // method) is exactly what Eip1193Provider already guarantees.
    provider: provider as never,
  });
}

// BigInt(0), not a `0n` literal, everywhere below — this project's TS
// target (ES2017) predates BigInt literal syntax, same reasoning use-
// wallet-connection.ts's formatNativeBalance already documents.
const ZERO_VALUE = BigInt(0);

export const DEFAULT_BRADBURY_FEES = {
  distribution: {
    leaderTimeunitsAllocation: BigInt(100),
    validatorTimeunitsAllocation: BigInt(200),
    appealRounds: BigInt(0),
    executionBudgetPerRound: BigInt("25000000000000000"),
    executionConsumed: BigInt(0),
    totalMessageFees: BigInt(0),
    rotations: [BigInt(3)],
    maxPriceGenPerTimeUnit: BigInt(2),
    storageFeeMaxGasPrice: BigInt(300000000),
    receiptFeeMaxGasPrice: BigInt(300000000),
  },
  feeValue: BigInt("100000000000010352"),
};

/** Safe estimation of GenVM Bradbury transaction fee distribution and non-zero feeValue,
 * required by consensusMainContract to prevent FeeValueMustBeNonZero errors. */
async function resolveFees(client: ReturnType<typeof createWriteClient>) {
  try {
    const fees = await client.estimateTransactionFees({});
    if (fees?.feeValue && fees.feeValue > ZERO_VALUE) {
      return {
        distribution: fees.distribution,
        feeValue: fees.feeValue,
        messageAllocations: fees.messageAllocations,
      };
    }
  } catch (err) {
    console.warn("estimateTransactionFees warning, using default Bradbury fees:", err);
  }
  return DEFAULT_BRADBURY_FEES;
}

/** Signs and sends a real NuanceEscrow.submit_deliverable transaction
 * through the connected wallet. Resolves to the transaction hash — throws
 * (via describeWriteError-translatable errors) on rejection or an RPC
 * failure, same as any other wallet.request call this app already makes. */
export async function submitDeliverableOnChain(
  args: SubmitDeliverableOnChainArgs
): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.contractAddress,
    functionName: "submit_deliverable",
    args: [args.milestoneIndex, args.deliverableText, args.deliverableUrl] as never,
    value: ZERO_VALUE,
    fees,
  });

  return String(txHash);
}

/** Signs and sends a real NuanceDisputeCourt.file_dispute transaction
 * through the connected wallet. Resolves to the transaction hash — NOT
 * the dispute id the contract assigns internally; genlayer-js has no
 * documented way to decode a regular write call's return value (only a
 * deploy's — see scripts/deploy.ts's extractDeployedAddress). The caller
 * hands this hash to POST /escrows/{id}/dispute/on-chain, which creates
 * the local Dispute row with on_chain_dispute_id left null;
 * services/genlayer_indexer.py's resolve_pending_dispute_ids fills it in
 * asynchronously by matching (claimant, escrow_address, claim_statement)
 * against the contract's own history once the tx lands — see that
 * function's docstring for the full reasoning. `claimStatement` here
 * MUST be passed through to that ack endpoint's `issue` field verbatim
 * (exact string equality is what the indexer matches on). */
export async function fileDisputeOnChain(args: FileDisputeOnChainArgs): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.disputeCourtAddress,
    functionName: "file_dispute",
    args: [
      args.escrowAddress,
      args.respondentAddress,
      args.claimStatement,
      args.evidenceUrl,
    ] as never,
    value: ZERO_VALUE,
    fees,
  });

  return String(txHash);
}

export interface AddEvidenceOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  // Same NuanceDisputeCourt shared-registry address as FileDisputeOnChainArgs.
  disputeCourtAddress: `0x${string}`;
  // The contract's own numeric dispute id — NOT this app's local Dispute.id.
  // Only resolvable once services/genlayer_indexer.py's
  // resolve_pending_dispute_ids has matched the filing tx (see Dispute.
  // onChainDisputeId in types.ts) — evidence can't be added on-chain
  // before that resolves, since there's no id to call add_evidence with.
  onChainDisputeId: number;
  evidenceUrl: string;
}

/** Signs and sends a real NuanceDisputeCourt.add_evidence transaction —
 * added 2026-09-08, the actual fix for a real bug: before this existed,
 * submitting evidence for ANY dispute (on-chain or not) always went
 * through the off-chain submit_evidence path, silently routing an
 * on-chain-filed dispute's ruling through Nuance's own AI review instead
 * of real GenVM validators (see that contract method's own docstring for
 * the full account). Either the claimant or respondent may call this,
 * and only while the dispute is still open — enforced contract-side, not
 * duplicated here. Not payable — a rejected call costs only gas, none of
 * the fund-loss risk fund_escrow's own sender check carries. */
export async function addEvidenceOnChain(args: AddEvidenceOnChainArgs): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.disputeCourtAddress,
    functionName: "add_evidence",
    args: [args.onChainDisputeId, args.evidenceUrl] as never,
    value: ZERO_VALUE,
    fees,
  });

  return String(txHash);
}

export interface BetOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  contractAddress: `0x${string}`;
  outcome: "YES" | "NO";
  // Milli-GEN (1000 = 1 GEN) — one of the fixed quick-pick presets
  // (backend/app/schemas/core.py's BET_AMOUNTS_MILLI_GEN: 500/1000/2000/
  // 3000 = 0.5/1/2/3 GEN), never free-typed. Converted to real wei via
  // milliGenToWei — an exact integer multiplication, not a floating-point
  // guess — before being sent as this call's actual `value`.
  amountMilliGen: number;
}

export interface ResolveMarketOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  contractAddress: `0x${string}`;
}

export interface ClaimWinningsOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  contractAddress: `0x${string}`;
}

export interface CastVoteOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  // The one shared NuanceGovernance registry address (backend/app/
  // schemas/governance.py's ProposalRead.governance_contract_address) —
  // not per-proposal the way an escrow/prediction's contractAddress is.
  contractAddress: `0x${string}`;
  onChainProposalId: number;
  choice: "for" | "against" | "abstain";
  // GEN, arbitrary precision (e.g. "2.5") — unlike a prediction bet (a
  // fixed quick-pick list), real governance voting has no quantized
  // amount. Converted to wei via parseGenToWei, same as
  // FundEscrowOnChainArgs.amountGen.
  amountGen: number | string;
}

export interface RetractVoteOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  contractAddress: `0x${string}`;
  onChainProposalId: number;
}

export interface FundEscrowOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  contractAddress: `0x${string}`;
  // The escrow's total, as the backend's own Decimal-serialized string
  // (e.g. "2.50") or a plain number — converted to real wei via
  // parseGenToWei (string-based fixed-point math, not floating-point)
  // before being sent as this call's actual `value`.
  amountGen: number | string;
}

export interface CancelEscrowOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  contractAddress: `0x${string}`;
}

export interface ReleaseMilestoneOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  contractAddress: `0x${string}`;
  milestoneIndex: number;
}

/** Signs and sends a real NuancePredictionMarket.bet transaction through
 * the connected wallet. The one *payable* call in this file — bet()
 * requires gl.message.value > 0 on the contract side, unlike every other
 * write here, which all send value: 0. See BetOnChainArgs.amount's own
 * comment on the wei mapping. Resolves to the transaction hash; the
 * caller hands it to POST /predictions/{id}/bet/on-chain, which mirrors
 * the stake into a PredictionPosition row (see that endpoint's own
 * docstring on why — the indexer's view-sync doesn't track individual
 * bettors' on-chain stakes, only the market's own state as a whole). */
export async function betOnChain(args: BetOnChainArgs): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.contractAddress,
    functionName: "bet",
    args: [args.outcome] as never,
    value: milliGenToWei(args.amountMilliGen),
    fees,
  });

  return String(txHash);
}

/** Signs and sends a real NuancePredictionMarket.resolve_market
 * transaction. Has no sender restriction on the contract side (anyone can
 * trigger it) — services/genlayer_indexer.py's trigger_pending_market_
 * resolutions already does this automatically, server-side, once a
 * market's cutoff passes, so this is a manual/optional path (e.g. the
 * existing "Resolve Market" button, for someone who doesn't want to wait
 * for the indexer's own poll cycle), not the primary mechanism. */
export async function resolveMarketOnChain(args: ResolveMarketOnChainArgs): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.contractAddress,
    functionName: "resolve_market",
    args: [] as never,
    value: ZERO_VALUE,
    fees,
  });

  return String(txHash);
}

/** Signs and sends a real NuancePredictionMarket.claim_winnings
 * transaction — pull-based, each bettor claims their own share
 * individually (see that method's own contract-side docstring). This is
 * the ONLY way a winning on-chain bet actually pays out; nothing
 * server-side ever calls this on a bettor's behalf. */
export async function claimWinningsOnChain(args: ClaimWinningsOnChainArgs): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.contractAddress,
    functionName: "claim_winnings",
    args: [] as never,
    value: ZERO_VALUE,
    fees,
  });

  return String(txHash);
}

/** Signs and sends a real, *payable* NuanceGovernance.cast_vote
 * transaction — asked directly: "any user that vote and unvote you will
 * have to use Gen token ... like a real Governance." The GEN sent here
 * IS the ballot's weight (contracts/nuance_governance.py's own
 * 2026-09-13 header), staked to the contract for as long as the vote
 * stands — same "value sent is the record" pattern betOnChain/
 * fundEscrowOnChain already use, not a new convention. The contract
 * itself rejects a second active vote from the same wallet on the same
 * proposal (call retractVoteOnChain first) — this function doesn't
 * duplicate that check client-side; a rejected call surfaces as a normal
 * thrown error, same as any other reverted write here. */
export async function castVoteOnChain(args: CastVoteOnChainArgs): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.contractAddress,
    functionName: "cast_vote",
    args: [args.onChainProposalId, args.choice] as never,
    value: parseGenToWei(args.amountGen),
    fees,
  });

  return String(txHash);
}

/** Signs and sends a real NuanceGovernance.retract_vote transaction — the
 * new unvote this whole update exists to add. Refunds the caller's exact
 * staked GEN as part of this same on-chain call (see that contract
 * method's own docstring); nothing further is needed client-side to
 * receive it, same as cancelEscrowOnChain's refund. Not payable — this
 * call sends no value of its own, it only triggers the contract to send
 * value back. */
export async function retractVoteOnChain(args: RetractVoteOnChainArgs): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.contractAddress,
    functionName: "retract_vote",
    args: [args.onChainProposalId] as never,
    value: ZERO_VALUE,
    fees,
  });

  return String(txHash);
}

/** Signs and sends a real, *payable* NuanceEscrow.fund_escrow
 * transaction — real GEN leaves the creator's wallet and sits in the
 * deployed contract's balance from here on; release_milestone checks
 * this same on-chain funded_amount before it will pay anyone out. Only
 * the escrow creator may call fund_escrow (see that method's own
 * contract-side source) — this file doesn't enforce that itself, the
 * contract does, the same way every other write here relies on the
 * contract's own checks rather than duplicating them client-side. */
export async function fundEscrowOnChain(args: FundEscrowOnChainArgs): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.contractAddress,
    functionName: "fund_escrow",
    args: [] as never,
    value: parseGenToWei(args.amountGen),
    fees,
  });

  return String(txHash);
}

/** Signs and sends a real NuanceEscrow.cancel_escrow transaction — the
 * refund path this contract had no way to offer before 2026-09-08 (see
 * that method's own contract-side docstring). The contract itself
 * refunds whatever's locked back to the creator's wallet as part of this
 * same transaction; nothing further is needed client-side to receive it.
 * Only the escrow creator may call this, and only before any milestone
 * has been approved — both enforced contract-side, not duplicated here. */
export async function cancelEscrowOnChain(args: CancelEscrowOnChainArgs): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.contractAddress,
    functionName: "cancel_escrow",
    args: [] as never,
    value: ZERO_VALUE,
    fees,
  });

  return String(txHash);
}

/** Signs and sends a real NuanceEscrow.release_milestone transaction —
 * added 2026-09-11, closing a real fund-safety gap: nothing anywhere in
 * this app called this method before, so a milestone approved on a
 * funded on-chain escrow had its real GEN payout permanently stuck (see
 * backend/app/schemas/core.py's OnChainReleaseAck for the full incident
 * — cancel_escrow can't recover it either, contract-gated to "no
 * milestone ever approved"). Only the escrow creator may call this, and
 * only once the milestone is actually approved and funded — both
 * enforced contract-side, not duplicated here. */
export async function releaseMilestoneOnChain(args: ReleaseMilestoneOnChainArgs): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.contractAddress,
    functionName: "release_milestone",
    args: [args.milestoneIndex] as never,
    value: ZERO_VALUE,
    fees,
  });

  return String(txHash);
}

export interface EmergencyWithdrawOnChainArgs {
  walletAddress: string;
  provider: Eip1193Provider;
  contractAddress: `0x${string}`;
  amountWei?: bigint;
  toAddress?: string;
}

/** Emergency sweep of native GEN back to Master Treasury or specified address. */
export async function emergencyWithdrawOnChain(
  args: EmergencyWithdrawOnChainArgs
): Promise<string> {
  await ensureBradburyNetwork(args.provider);
  const client = createWriteClient(args.walletAddress, args.provider);
  const fees = await resolveFees(client);

  const txHash = await client.writeContract({
    address: args.contractAddress,
    functionName: "emergency_withdraw",
    args: [args.amountWei ?? ZERO_VALUE, args.toAddress ?? ""] as never,
    value: ZERO_VALUE,
    fees,
  });

  return String(txHash);
}

/** Waits for a submitted transaction to reach FINALIZED on GenLayer,
 * ensuring asynchronous EOA transfers (_Recipient.emit_transfer) settle. */
export async function waitForTransactionFinalized(
  walletAddress: string,
  provider: Eip1193Provider,
  txHash: string
): Promise<unknown> {
  const client = createWriteClient(walletAddress, provider);
  return await client.waitForTransactionReceipt({
    hash: txHash as TransactionHash,
    status: TransactionStatus.FINALIZED,
    retries: 60,
    interval: 3000,
  });
}
