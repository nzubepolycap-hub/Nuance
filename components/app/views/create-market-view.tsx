// 2026-09-12 rebrand — the real Create-Market form, replacing services/
// market_generator.py's tweet-scraping pipeline as the actual way new
// markets get made (see lib/api.ts's CreatePredictionPayload and
// backend/app/schemas/core.py's PredictionCreate for the full account of
// why: that pipeline's questions were incoherent "Will this GenLayer
// claim hold true: [raw tweet fragment]?" wrappers, and it required
// GEMINI_API_KEY just to formulate them). No LLM here — a person writes
// the question and criteria directly, mirroring CreateEscrowView's own
// pattern exactly.
export function CreateMarketView({
  formTitle,
  formCategory,
  formResolutionDate,
  formResolutionSourceUrl,
  formDescription,
  onTitleChange,
  onCategoryChange,
  onResolutionDateChange,
  onResolutionSourceUrlChange,
  onDescriptionChange,
  onCancel,
  onSubmit,
}: {
  formTitle: string;
  formCategory: string;
  formResolutionDate: string;
  formResolutionSourceUrl: string;
  formDescription: string;
  onTitleChange: (v: string) => void;
  onCategoryChange: (v: string) => void;
  onResolutionDateChange: (v: string) => void;
  onResolutionSourceUrlChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  // Mirrors backend/app/schemas/core.py's PredictionCreate validators —
  // client-side pre-check only (matching every other create-form's own
  // "hides a button that would obviously fail" reasoning in this app);
  // the backend's own validation is what actually enforces this.
  const titleIsQuestion = formTitle.trim().endsWith("?");
  const urlLooksValid =
    formResolutionSourceUrl.trim().startsWith("http://") ||
    formResolutionSourceUrl.trim().startsWith("https://");
  const disabled = !(
    formTitle.trim().length >= 10 &&
    titleIsQuestion &&
    formCategory.trim() &&
    formResolutionDate &&
    formResolutionSourceUrl.trim() &&
    urlLooksValid &&
    formDescription.trim().length >= 20
  );

  return (
    <div className="max-w-[560px]" style={{ animation: "fadeUp 0.3s ease" }}>
      <div
        onClick={onCancel}
        className="mb-4.5 inline-block cursor-pointer text-sm text-fg-meta transition-colors hover:text-fg"
      >
        ← Cancel
      </div>
      <div className="mb-1.5 font-display text-2xl font-bold">New Market</div>
      <div className="mb-6 text-[13px] text-fg-dim-2">
        On-chain only — this deploys a real NuancePredictionMarket contract, judged by
        GenVM&rsquo;s own validator committee, not an off-chain AI guess. It stays hidden
        until the deploy finishes (usually a few minutes).
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <div className="mb-1.5 text-[13px] text-fg-meta">
            Question — must resolve to a clear yes/no
          </div>
          <input
            value={formTitle}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="e.g. Will GenLayer's mainnet launch before March 2027?"
            className="w-full rounded-lg border border-border-4 bg-surface-1 px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint-2"
          />
          {formTitle.trim().length > 0 && !titleIsQuestion && (
            <div className="mt-1 text-[12px] text-negative-text">
              Must end in a question mark.
            </div>
          )}
        </div>
        <div>
          <div className="mb-1.5 text-[13px] text-fg-meta">Category</div>
          <input
            value={formCategory}
            onChange={(e) => onCategoryChange(e.target.value)}
            placeholder="e.g. Crypto, GenLayer Ecosystem, Sports"
            className="w-full rounded-lg border border-border-4 bg-surface-1 px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint-2"
          />
        </div>
        <div>
          <div className="mb-1.5 text-[13px] text-fg-meta">
            Resolves by
          </div>
          <input
            type="datetime-local"
            value={formResolutionDate}
            onChange={(e) => onResolutionDateChange(e.target.value)}
            className="w-full rounded-lg border border-border-4 bg-surface-1 px-3 py-2.5 font-brand-mono text-sm text-fg"
          />
        </div>
        <div>
          <div className="mb-1.5 text-[13px] text-fg-meta">
            Resolution source URL — GenVM validators fetch this page to decide
          </div>
          <input
            value={formResolutionSourceUrl}
            onChange={(e) => onResolutionSourceUrlChange(e.target.value)}
            placeholder="https://genlayer.com/blog"
            className="w-full rounded-lg border border-border-4 bg-surface-1 px-3 py-2.5 font-brand-mono text-sm text-fg placeholder:text-fg-faint-2"
          />
          {formResolutionSourceUrl.trim().length > 0 && !urlLooksValid && (
            <div className="mt-1 text-[12px] text-negative-text">
              Must start with http:// or https://.
            </div>
          )}
        </div>
        <div>
          <div className="mb-1.5 text-[13px] text-fg-meta">
            Resolution criteria — exactly what on the source page decides YES vs NO
          </div>
          <textarea
            value={formDescription}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="e.g. Resolves YES if genlayer.com's official blog announces mainnet has launched before the resolution date. Resolves NO otherwise."
            className="min-h-[100px] w-full resize-y rounded-lg border border-border-4 bg-surface-1 px-3 py-2.5 font-sans text-sm text-fg placeholder:text-fg-faint-2"
          />
        </div>
        <button
          onClick={onSubmit}
          disabled={disabled}
          className="mt-1.5 cursor-pointer rounded-[9px] border border-border-6 bg-chip-hover px-5 py-3.5 text-sm font-semibold transition-colors hover:bg-chip-hover-2 disabled:cursor-default"
          style={{ opacity: disabled ? 0.5 : 1 }}
        >
          Create Market
        </button>
      </div>
    </div>
  );
}
