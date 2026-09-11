import type { Escrow } from "@/components/app/types";
import { StatusBadge } from "@/components/app/status-badge";
import { activeMilestoneIndex, formatAddress, initials } from "@/components/app/status";

export function DashboardView({
  escrows,
  onOpenCreate,
  onOpenEscrow,
}: {
  escrows: Escrow[];
  onOpenCreate: () => void;
  onOpenEscrow: (id: number) => void;
}) {
  // Native-asset (GEN) escrows only — summing every escrow's `total`
  // regardless of which Asset (ROADMAP.md Part 4 6.2) it's actually
  // denominated in would silently blend e.g. testnet USDC amounts into a
  // tile labeled "GEN". A genuinely correct multi-asset total would need
  // a per-asset breakdown, not one blended number with no fixed unit —
  // out of scope here; this just keeps the existing GEN-labeled tile
  // honest about its own unit, same fix backend/app/routers/analytics.py
  // and services/genlayer_deploy.py both needed for the same reason.
  const totalEscrowed = escrows
    .filter((e) => e.asset.isNative)
    .reduce((s, e) => s + (Number(e.total) || 0), 0);
  const activeReviewCount = escrows.filter(
    (e) => e.statusKey === "in_review" || e.milestones.some((m) => m.statusKey === "in_review")
  ).length;
  const settledCount = escrows.filter((e) => e.statusKey === "approved").length;

  return (
    <div style={{ animation: "fadeUp 0.3s ease" }}>
      <div className="mb-8 flex items-end justify-between">
        <div>
          <div className="font-display text-[30px] font-bold">Escrows</div>
          <div className="mt-1 text-[15px] text-fg-dim-2">
            Milestones adjudicated by AI-validator consensus.
          </div>
        </div>
        <button
          onClick={onOpenCreate}
          className="cursor-pointer rounded-[9px] border border-border-6 bg-chip-hover px-5 py-3 text-sm font-semibold transition-colors hover:bg-chip-hover-2"
        >
          + New Escrow
        </button>
      </div>

      <div className="mb-9 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-[14px] border border-border-1 bg-surface-1 p-5">
          <div className="text-xs uppercase tracking-wide text-fg-meta">
            Total Escrowed
          </div>
          <div className="mt-1.5 font-display text-[26px] font-bold">
            {totalEscrowed.toLocaleString()} <span className="text-sm font-normal text-fg-meta">GEN</span>
          </div>
        </div>
        <div className="rounded-[14px] border border-border-1 bg-surface-1 p-5">
          <div className="text-xs uppercase tracking-wide text-fg-meta">
            Active Reviews
          </div>
          <div className="mt-1.5 font-display text-[26px] font-bold">
            {activeReviewCount}
          </div>
        </div>
        <div className="rounded-[14px] border border-border-1 bg-surface-1 p-5">
          <div className="text-xs uppercase tracking-wide text-fg-meta">
            Settled Escrows
          </div>
          <div className="mt-1.5 font-display text-[26px] font-bold text-positive">
            {settledCount} <span className="text-sm font-normal text-fg-meta">/ {escrows.length}</span>
          </div>
        </div>
      </div>

      {escrows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-[16px] border border-dashed border-border-4 bg-surface-1/50 px-6 py-16 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-border-4 bg-surface-2 text-xl text-fg-meta">
            ∅
          </div>
          <div className="text-base font-semibold text-fg">No data available</div>
          <p className="mt-1 max-w-md text-sm text-fg-meta">
            You have no active or completed escrows yet. Create a new escrow to start adjudicating milestones with AI-validator consensus.
          </p>
          <button
            onClick={onOpenCreate}
            className="mt-5 cursor-pointer rounded-[9px] border border-border-6 bg-chip-hover px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-chip-hover-2"
          >
            + Create First Escrow
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {escrows.map((e) => {
            const activeIdx = activeMilestoneIndex(e.milestones);
            const activeMilestone = e.milestones[activeIdx] ?? e.milestones[0];
            return (
              <div
                key={e.id}
                onClick={() => onOpenEscrow(e.id)}
                className="flex cursor-pointer items-center justify-between rounded-[14px] border border-border-1 bg-surface-1 p-5 transition-colors hover:border-border-6"
              >
                <div className="flex items-center gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-border-6 bg-chip-hover font-display font-bold">
                    {initials(e.title)}
                  </div>
                  <div>
                    <div className="text-[15px] font-semibold">{e.title}</div>
                    <div className="mt-0.5 text-[13px] text-fg-meta">
                      with {formatAddress(e.counterpartyAddress)}
                      {activeMilestone ? ` · ${activeMilestone.name}` : ""}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-5">
                  <div className="text-right">
                    <div className="font-brand-mono text-sm font-semibold">
                      {e.total.toLocaleString()}
                    </div>
                    <div className="text-xs text-fg-meta">{e.asset.symbol}</div>
                  </div>
                  <StatusBadge status={e.statusKey} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

