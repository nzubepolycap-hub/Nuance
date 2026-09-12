import type { Prediction } from "@/components/app/types";

export function PredictionsView({
  predictions,
  onOpen,
  onOpenCreate,
  notice,
}: {
  predictions: Prediction[];
  onOpen: (id: number) => void;
  onOpenCreate: () => void;
  // Shown once right after a successful create — the new market itself
  // won't be in `predictions` yet (starts "pending_review", hidden until
  // its GenVM contract actually deploys), so without this the list would
  // look like nothing happened. See nuance-app.tsx's createMarketNotice.
  notice?: string | null;
}) {
  return (
    <div style={{ animation: "fadeUp 0.3s ease" }}>
      <div className="mb-1 flex items-start justify-between gap-4">
        <div className="font-display text-[30px] font-bold">
          Prediction Markets
        </div>
        <button
          onClick={onOpenCreate}
          className="mt-1 shrink-0 cursor-pointer rounded-[9px] border border-border-6 bg-chip-hover px-4 py-2.5 text-[13px] font-semibold transition-colors hover:bg-chip-hover-2"
        >
          + New Market
        </button>
      </div>
      <div className="mb-7 mt-1 text-[15px] text-fg-dim-2">
        Real GEN staked on real outcomes, settled by GenVM&rsquo;s on-chain validator committee.
      </div>

      {notice && (
        <div className="mb-5 rounded-[12px] border border-positive/40 bg-positive/10 px-4 py-3 text-[13px] text-positive-text">
          {notice}
        </div>
      )}

      {predictions.length === 0 ? (
        <div className="rounded-[14px] border border-border-1 bg-surface-1 p-8 text-center text-[14px] text-fg-meta">
          No open markets yet. Be the first to create one.
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {predictions.map((p) => (
            <div
              key={p.id}
              onClick={() => onOpen(p.id)}
              className="flex cursor-pointer items-center justify-between rounded-[14px] border border-border-1 bg-surface-1 p-5 transition-colors hover:border-border-6"
            >
              <div className="flex-1">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-review-text">
                  {p.category}
                </div>
                <div className="max-w-[480px] text-[15px] font-semibold">
                  {p.question}
                </div>
                <div className="mt-1.5 text-[13px] text-fg-meta">
                  Resolves {p.resolveDate} · {(p.volume / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} GEN volume
                </div>
              </div>
              <div className="rounded-[10px] bg-surface-3 px-4.5 py-2.5 text-center">
                <div className="font-display text-xl font-bold text-positive-text">
                  {p.yesPrice}¢
                </div>
                <div className="text-[11px] text-fg-meta">YES</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
