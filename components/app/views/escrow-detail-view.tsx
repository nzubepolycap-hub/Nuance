import type { Escrow, EscrowVerdict } from "@/components/app/types";
import { StatusBadge } from "@/components/app/status-badge";
import { ChainStatusBadge } from "@/components/app/chain-status-badge";
import { activeMilestoneIndex, formatAddress } from "@/components/app/status";
import { ConsensusPanel, type ConsensusVerdict } from "@/components/app/consensus-panel";
import { LEGACY_OFFCHAIN } from "@/lib/chain-status";

export function EscrowDetailView({
  escrow,
  stage,
  deliverableText,
  verdict,
  onBack,
  onDeliverableChange,
  onSubmitDeliverable,
  onReleasePayment,
  onEscalate,
  onFundEscrow,
  onCancelEscrow,
  submitDisabled = false,
  escalateDisabled = false,
  fundingDisabled = false,
  cancellingDisabled = false,
  connectedWalletAddress = null,
  milestoneReleased = false,
  existingDisputeId = null,
  onViewExistingDispute,
}: {
  escrow: Escrow;
  stage: number;
  deliverableText: string;
  verdict: EscrowVerdict | null;
  onBack: () => void;
  onDeliverableChange: (text: string) => void;
  onSubmitDeliverable: () => void;
  onReleasePayment: () => void;
  onEscalate: () => void;
  // Only present once this escrow is linked to a deployed contract — see
  // the "Fund Escrow" card below.
  onFundEscrow?: () => void;
  // Same — only present once contract-linked. See the "Cancel Escrow"
  // button below for exactly when it's actually shown/usable.
  onCancelEscrow?: () => void;
  // True while an on-chain submit is mid-flight (waiting on the wallet's
  // own signing prompt / RPC round-trip) — a separate condition from
  // "text is empty," which the button already gates on its own.
  submitDisabled?: boolean;
  // True while POST /escrows/{id}/dispute is in flight.
  escalateDisabled?: boolean;
  // True while the real, payable fund_escrow transaction is mid-flight.
  fundingDisabled?: boolean;
  // True while the real cancel_escrow transaction is mid-flight.
  cancellingDisabled?: boolean;
  // The currently connected wallet, or null if none — used ONLY to hide
  // Fund/Cancel from a wallet that obviously isn't the creator (both are
  // creator-gated contract-side). Added 2026-09-08 after a live test
  // showed "Fund Escrow" staying visible and signable from the
  // counterparty's own wallet — nuance-app.tsx's fundEscrow/cancelEscrow
  // handlers now also refuse this server-side-equivalent case
  // client-side before ever sending a transaction (critical for funding
  // specifically: GenVM doesn't refund a payable call's value on
  // revert), but hiding the button too avoids the confusing prompt
  // altogether rather than just rejecting it after the wallet popup.
  connectedWalletAddress?: string | null;
  // True once the active milestone's payout has actually happened — see
  // types.ts's Milestone.releasedAt. Found live, same session as the
  // wallet-check fix above: "Release Payment" kept showing (and kept
  // genuinely failing — see routers/escrows.py's _releasable_milestone
  // fix) after a real release had already gone through, since neither
  // the verdict nor the milestone's own statusKey change once released.
  milestoneReleased?: boolean;
  // Set once a Dispute already exists for this escrow (any status —
  // even a resolved one still means "already escalated once," not
  // "escalate again"). Found the same way: clicking "Escalate to
  // Internet Court" a second time for the same disagreement would file
  // a genuinely duplicate on-chain/off-chain dispute.
  existingDisputeId?: number | null;
  // Present whenever existingDisputeId is — jumps straight to that
  // dispute room instead of offering to file a new one.
  onViewExistingDispute?: () => void;
}) {
  const isConnectedAsCreator =
    connectedWalletAddress != null &&
    connectedWalletAddress.toLowerCase() === escrow.creatorAddress.toLowerCase();
  const activeIdx = activeMilestoneIndex(escrow.milestones);
  const activeMilestone = escrow.milestones[activeIdx];
  // Same fix as ChainStatusBadge's own contractLinked prop: a submission
  // not yet made still routes on-chain if the milestone is actually
  // linked — chainStatus alone only reflects what's already happened.
  const activeMilestoneOnChain =
    (activeMilestone?.chainStatus ?? LEGACY_OFFCHAIN) !== LEGACY_OFFCHAIN ||
    (Boolean(escrow.contractAddress) && activeMilestone?.onChainIndex != null);

  const consensusVerdict: ConsensusVerdict | null = verdict
    ? {
        label: verdict.label,
        colorClass: verdict.approved ? "text-positive-text" : "text-negative-text",
        panelBgClass: verdict.approved ? "bg-positive/10" : "bg-negative/10",
        panelBorderClass: verdict.approved
          ? "border-positive/30"
          : "border-negative/30",
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        actions: verdict.approved ? (
          milestoneReleased ? (
            <div className="text-xs font-medium text-fg-meta">✓ Payment already released.</div>
          ) : (
            <button
              onClick={onReleasePayment}
              className="cursor-pointer rounded-lg border-none bg-positive px-4 py-2.5 text-[13px] font-semibold text-positive-fg transition-[filter] hover:brightness-110"
            >
              Release Payment
            </button>
          )
        ) : existingDisputeId != null ? (
          <button
            onClick={onViewExistingDispute}
            className="cursor-pointer rounded-lg border-none bg-negative px-4 py-2.5 text-[13px] font-semibold text-white transition-[filter] hover:brightness-110"
          >
            View Dispute Room #{existingDisputeId}
          </button>
        ) : (
          <button
            onClick={onEscalate}
            disabled={escalateDisabled}
            className="cursor-pointer rounded-lg border-none bg-negative px-4 py-2.5 text-[13px] font-semibold text-white transition-[filter] hover:brightness-110 disabled:cursor-default disabled:opacity-60"
          >
            {escalateDisabled ? "Filing dispute…" : "Escalate to Internet Court"}
          </button>
        ),
      }
    : null;

  // Only a contract-linked, not-yet-funded escrow has anything to fund —
  // most escrows today are still off-chain (contractAddress null), and
  // once funded_tx_hash is set this app treats funding as already done
  // (see types.ts's Escrow.fundedTxHash for the caveat on what that
  // does/doesn't guarantee).
  // RE-ENABLED (2026-09-08) — the underlying bug is fixed and verified
  // against a real live Bradbury redeploy, not just code review:
  // NuanceEscrow's constructor now takes an explicit `creator` arg
  // (deploy_escrow_contract passes the real escrow.creator_address, not
  // gl.message.sender_address — see the contract's own __init__ docstring
  // for the full account of why that was wrong and cost real GEN), and a
  // fresh test deploy read back `creator` matching the real address
  // exactly, with milestone.amount correctly landing as real wei
  // (1000000000000000000, no JSON-bridge precision loss — see
  // genlayer_deploy.py's _gen_to_wei/_bigint_arg). Escrow #3 specifically
  // was redeployed under the corrected contract as part of this fix; its
  // original broken contract (and the 1 GEN stuck in it) stays abandoned.
  // isConnectedAsCreator added 2026-09-08 — see that flag's own comment
  // above for why (a live test found this staying visible/signable from
  // the wrong wallet).
  const showFundCard =
    Boolean(escrow.contractAddress) && !escrow.fundedTxHash && isConnectedAsCreator;

  // Client-side pre-check only, matching cancel_escrow's own on-chain
  // condition (see that method's docstring on why a deadline gate isn't
  // included: no on-chain clock exists for it to check) — hides a button
  // that would obviously fail rather than let someone pay gas to find
  // that out. The contract itself is the real enforcement either way.
  const canCancel =
    Boolean(escrow.contractAddress) &&
    escrow.statusKey !== "cancelled" &&
    !escrow.milestones.some((m) => m.statusKey === "approved") &&
    isConnectedAsCreator;

  return (
    <div style={{ animation: "fadeUp 0.3s ease" }}>
      <div
        onClick={onBack}
        className="mb-4.5 inline-block cursor-pointer text-sm text-fg-meta transition-colors hover:text-fg"
      >
        ← Back to escrows
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-display text-2xl font-bold">{escrow.title}</div>
          <div className="mt-1.5 text-sm text-fg-dim-2">
            Counterparty{" "}
            <span className="font-brand-mono text-fg-bright">
              {formatAddress(escrow.counterpartyAddress)}
            </span>{" "}
            · Creator{" "}
            <span className="font-brand-mono text-fg-bright">
              {formatAddress(escrow.creatorAddress)}
            </span>{" "}
            · Total{" "}
            <span className="font-semibold text-fg">
              {escrow.total.toLocaleString()} {escrow.asset.symbol}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <StatusBadge status={escrow.statusKey} />
          {canCancel && onCancelEscrow && (
            <button
              onClick={onCancelEscrow}
              disabled={cancellingDisabled}
              title="Refunds whatever's locked back to you — only possible before any milestone is approved."
              className="cursor-pointer rounded-lg border border-negative/30 bg-negative/10 px-3 py-1.5 text-xs font-semibold text-negative-text transition-colors hover:bg-negative/20 disabled:cursor-default disabled:opacity-60"
            >
              {cancellingDisabled ? "Cancelling…" : "Cancel & Refund"}
            </button>
          )}
        </div>
      </div>

      {showFundCard && (
        <div className="mt-5 rounded-xl border border-review/30 bg-review/10 p-4.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-semibold text-review-text">
                Escrow contract deployed — awaiting funding
              </div>
              <div className="mt-1 text-xs text-fg-meta">
                Send {escrow.total.toLocaleString()} {escrow.asset.symbol} from your wallet into this
                escrow&rsquo;s contract before any milestone can be released.
              </div>
            </div>
            {onFundEscrow && (
              <button
                onClick={onFundEscrow}
                disabled={fundingDisabled}
                className="cursor-pointer rounded-lg border border-review/40 bg-review/20 px-4 py-2.5 text-[13px] font-semibold text-review-text transition-colors hover:bg-review/30 disabled:cursor-default disabled:opacity-60"
              >
                {fundingDisabled
                  ? "Waiting for wallet…"
                  : `Fund Escrow (${escrow.total.toLocaleString()} ${escrow.asset.symbol})`}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="mt-7 grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col gap-3">
          <div className="mb-0.5 text-xs uppercase tracking-wide text-fg-meta">
            Milestones
          </div>
          {escrow.milestones.map((m, i) => {
            const isActive =
              i === activeIdx &&
              (m.statusKey === "pending" ||
                m.statusKey === "in_review" ||
                m.statusKey === "in_progress" ||
                m.statusKey === "disputed");
            return (
              <div
                key={m.name}
                className="rounded-xl border border-border-1 bg-surface-1 p-4.5"
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">{m.name}</div>
                  <StatusBadge status={m.statusKey} />
                </div>
                <div className="mt-1.5 text-[13px] text-fg-meta">
                  {m.criteria}
                </div>
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="font-brand-mono text-[13px] text-fg-bright">
                    {m.amount.toLocaleString()} GEN
                  </div>
                  <ChainStatusBadge
                    chainStatus={m.chainStatus ?? LEGACY_OFFCHAIN}
                    txHash={m.onChainTxHash}
                    contractLinked={Boolean(escrow.contractAddress) && m.onChainIndex != null}
                  />
                </div>

                {m.statusKey === "approved" && (
                  <div className="mt-3 rounded-lg border border-positive/30 bg-positive/10 px-3 py-2 text-xs font-medium text-positive-text">
                    <div>
                      ✓ Milestone deliverable approved by{" "}
                      {(m.chainStatus ?? LEGACY_OFFCHAIN) === LEGACY_OFFCHAIN
                        ? "Nuance's off-chain AI consensus"
                        : "real GenVM validator consensus on Bradbury"}
                      .
                    </div>
                    {/* Real validator reasoning — added 2026-09-08. Used
                        to be discarded entirely for on-chain milestones
                        (see models/core.py's Milestone.reasoning), so
                        this text was only ever visible by reading the
                        raw chain explorer directly. */}
                    {m.reasoning && (
                      <div className="mt-1.5 border-t border-positive/20 pt-1.5 font-normal text-fg-bright">
                        {m.reasoning}
                      </div>
                    )}
                  </div>
                )}

                {m.statusKey === "disputed" && (
                  <div className="mt-3 rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-xs font-medium text-negative-text">
                    <div>
                      ⚠ Milestone deliverable disputed by{" "}
                      {(m.chainStatus ?? LEGACY_OFFCHAIN) === LEGACY_OFFCHAIN
                        ? "Nuance's off-chain AI consensus"
                        : "real GenVM validator consensus on Bradbury"}
                      .
                    </div>
                    {m.reasoning && (
                      <div className="mt-1.5 border-t border-negative/20 pt-1.5 font-normal text-fg-bright">
                        {m.reasoning}
                      </div>
                    )}
                  </div>
                )}

                {isActive &&
                  stage === 0 &&
                  (m.statusKey === "pending" || m.statusKey === "in_progress") &&
                  escrow.statusKey !== "approved" &&
                  escrow.statusKey !== "disputed" && (
                    <div className="mt-3.5 border-t border-border-1 pt-3.5">
                      <textarea
                        value={deliverableText}
                        onChange={(e) => onDeliverableChange(e.target.value)}
                        placeholder="Paste deliverable URL, PR link, or describe the completed work for AI review…"
                        className="min-h-[78px] w-full resize-y rounded-lg border border-border-4 bg-surface-3 px-3 py-2.5 font-sans text-[13px] text-fg placeholder:text-fg-faint-2"
                      />
                      <button
                        onClick={onSubmitDeliverable}
                        disabled={!deliverableText.trim() || submitDisabled}
                        className="mt-2.5 cursor-pointer rounded-lg border border-border-6 bg-chip-hover px-4.5 py-2.5 text-[13px] font-semibold transition-colors hover:bg-chip-hover-2 disabled:cursor-default"
                        style={{ opacity: deliverableText.trim() && !submitDisabled ? 1 : 0.5 }}
                      >
                        {submitDisabled ? "Waiting for wallet…" : "Submit for AI Review"}
                      </button>
                    </div>
                  )}
              </div>
            );
          })}
        </div>

        <ConsensusPanel
          title={activeMilestoneOnChain ? "GenVM Validator Consensus" : "AI Validator Consensus"}
          subtitle={
            activeMilestoneOnChain
              ? "3-of-3 real GenVM validators on Bradbury adjudicate this milestone on-chain."
              : "Nuance's own off-chain AI review adjudicates this milestone — not GenVM."
          }
          stage={stage}
          analyzingLabel="Analyzing deliverable…"
          doneLabel="Consensus recorded"
          idleText="Awaiting deliverable submission…"
          verdict={consensusVerdict}
          sticky
        />
      </div>
    </div>
  );
}
