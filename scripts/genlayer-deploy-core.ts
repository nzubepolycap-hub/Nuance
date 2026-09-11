// scripts/genlayer-deploy-core.ts
//
// The verified GenVM deploy engine, extracted from scripts/deploy.ts so it
// can be shared with scripts/genlayer-deploy.ts (the stdin/stdout bridge
// backend/app/services/genlayer_deploy.py invokes to deploy a real
// NuanceEscrow instance per new escrow) without duplicating the hard-won
// fixes in deployOne/extractDeployedAddress/isAcceptedOrFinalized — see
// deploy.ts's own header for the five rounds of real live-Bradbury
// debugging that produced them. Behavior is unchanged from what deploy.ts
// already had; this is a mechanical extraction, re-verified by confirming
// `npm run deploy:contracts` still type-checks and runs identically
// against the same call shape afterward.

import {
  TransactionStatus,
  ExecutionResult,
  transactionsStatusNameToNumber,
  type GenLayerTransaction,
  type TransactionHash,
  type DecodedDeployData,
} from "genlayer-js/types";
import type { createClient } from "genlayer-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setDefaultResultOrder } from "node:dns";

// Confirmed live 2026-09-10: this environment (and, per Node's Happy-
// Eyeballs docs, plenty of real deployment targets too — a container
// with IPv6 disabled at the network level is common) has NO working IPv6
// route to Bradbury's RPC host at all — an IPv6 connection attempt fails
// in under 1ms ("no route to host"), not a slow timeout Happy Eyeballs
// would race against and recover from in time. rpc-bradbury.genlayer.com
// resolves AAAA records first (Cloudflare-fronted), so Node's default DNS
// order tries — and fails — IPv6 before ever reaching the IPv4 address
// that actually works, surfacing identically to every other transient
// failure as viem's own generic "fetch failed". This is a real,
// verifiable fix for a real, verified failure mode — not a guess: a
// manual client.readContract call against a live deployed escrow, run
// from this exact environment, went from consistently failing to
// succeeding 3/3 once this was set. Every entry point that talks to
// Bradbury needs this — deploy.ts/genlayer-deploy.ts/genlayer-write.ts/
// verify-real-consensus.ts all import this module, so setting it here
// once (a module-level side effect, guaranteed to run before any of
// their own network calls) covers all four; scripts/genlayer-read.ts
// doesn't import from here and sets the same thing independently.
setDefaultResultOrder("ipv4first");

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");
export const CONTRACTS_DIR = resolve(REPO_ROOT, "contracts");

// Bradbury's observed rate-limit error code, and how long to back off —
// see deploy.ts's header, "Rate limiting" paragraph.
const RATE_LIMIT_ERROR_CODE = -32005;
const RETRY_BACKOFF_MS = 2000;
const MAX_RETRIES = 5;

// Same signature scripts/genlayer-read.ts's own RETRYABLE_ERROR_PATTERN
// retries on the read side (see that file for the live-confirmed
// reasoning: Bradbury's shared public RPC node genuinely does drop a
// request outright now and then, a node-side blip a same-request retry
// clears far more often than not) — added here 2026-09-10, this side of
// the bridge (writeContract/deployContract/waitForTransactionReceipt)
// previously only ever retried a -32005 rate-limit response and NOT this
// pattern, so a transient network failure here failed outright with zero
// retries at all, unlike every read. Safe to retry the same way: a
// writeContract call that throws this specific error never got far
// enough to receive a transaction hash back, which is genlayer_write.py's
// own documented signal for "never actually submitted" — nothing here
// changes that contract, this only means fewer of those failures reach
// the Python caller at all.
const RETRYABLE_NETWORK_ERROR_PATTERN = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// BigInt-safe — plain JSON.stringify throws on any bigint field, which a
// GenLayerTransaction (u256 storage values, wei amounts) commonly has.
export function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

// Viem (which genlayer-js is built on) commonly nests the real JSON-RPC
// error under `.cause`, sometimes more than one level deep — checked
// recursively rather than assuming a fixed depth, plus a message-text
// fallback since the exact wrapping shape for a Bradbury -32005 response
// specifically hasn't been confirmed against a live example.
function extractErrorCode(err: unknown, depth = 0): number | undefined {
  if (depth > 5 || !err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code === "number") return e.code;
  if ("cause" in e) return extractErrorCode(e.cause, depth + 1);
  return undefined;
}

function isRateLimitError(err: unknown): boolean {
  if (extractErrorCode(err) === RATE_LIMIT_ERROR_CODE) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("-32005") || /rate limit/i.test(message);
}

function isRetryableNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RETRYABLE_NETWORK_ERROR_PATTERN.test(message);
}

// Despite the name kept for this exported function (3 other files already
// import it by this name — renaming is pure churn, not a behavior change,
// so left alone) this retries BOTH known-transient failure signatures now,
// not just rate-limiting — see RETRYABLE_NETWORK_ERROR_PATTERN's own
// comment above for why the second one was added.
export async function withRateLimitRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const rateLimited = isRateLimitError(err);
      const networkBlip = !rateLimited && isRetryableNetworkError(err);
      if ((!rateLimited && !networkBlip) || attempt >= MAX_RETRIES) throw err;
      console.warn(
        `  ${label}: ${rateLimited ? "rate limited (-32005)" : "transient network error"} — ` +
          `retrying in ${RETRY_BACKOFF_MS}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await sleep(RETRY_BACKOFF_MS);
    }
  }
}

// Checks every field observed to actually carry the status across a live
// receipt (camelCase per the .d.ts, snake_case per what the client really
// returned, and numeric as a last resort) rather than trusting any one of
// them alone — see deploy.ts header's third-round note.
function isAcceptedOrFinalized(receipt: GenLayerTransaction): boolean {
  const nameFromSnakeCase = (receipt as unknown as { status_name?: string }).status_name;
  const numericStatus = typeof receipt.status === "number" ? receipt.status : undefined;
  const acceptedNumber = Number(transactionsStatusNameToNumber[TransactionStatus.ACCEPTED]);
  const finalizedNumber = Number(transactionsStatusNameToNumber[TransactionStatus.FINALIZED]);

  return (
    receipt.statusName === TransactionStatus.ACCEPTED ||
    receipt.statusName === TransactionStatus.FINALIZED ||
    nameFromSnakeCase === TransactionStatus.ACCEPTED ||
    nameFromSnakeCase === TransactionStatus.FINALIZED ||
    numericStatus === acceptedNumber ||
    numericStatus === finalizedNumber
  );
}

function extractDeployedAddress(receipt: GenLayerTransaction, contractName: string): string {
  // Priority order, see deploy.ts's header note:
  // 1. The exact typed cast confirmed against a live deploy receipt.
  const decoded = (receipt.txDataDecoded as DecodedDeployData)?.contractAddress;
  // 2. The raw snake_case field observed directly on a live receipt —
  // not in GenLayerTransaction's declared type at all, accessed loosely.
  const raw = (receipt as unknown as { contract_address?: string }).contract_address;
  const address = decoded ?? raw ?? receipt.recipient ?? receipt.to_address;

  if (!address) {
    throw new Error(
      `${contractName}: couldn't find a deployed address on the transaction receipt ` +
        `(checked txDataDecoded.contractAddress, contract_address, recipient, and to_address — ` +
        `all empty). Full receipt: ${safeStringify(receipt)}`
    );
  }
  return address;
}

export interface DeployTarget {
  name: string;
  file: string;
  args: unknown[];
}

/** Deploys one contract (contracts/<file>) with `args`, waits for
 * ACCEPTED, and returns its address — the exact engine deploy.ts's
 * bootstrap deployments use, verified live against Bradbury multiple
 * times (see this file's header). Throws with the full receipt on any
 * failure — consensus-level (bad status) or execution-level
 * (FINISHED_WITH_ERROR, e.g. a real contract bug). */
export async function deployOne(
  client: ReturnType<typeof createClient>,
  target: DeployTarget
): Promise<string> {
  const contractPath = resolve(CONTRACTS_DIR, target.file);
  if (!existsSync(contractPath)) {
    throw new Error(`Contract source not found: ${contractPath}`);
  }
  // Raw bytes, not a UTF-8 string — see deploy.ts header's second-round note.
  const code = new Uint8Array(readFileSync(contractPath));

  const txHash = await withRateLimitRetry(`${target.name} deployContract`, () =>
    client.deployContract({
      code,
      args: target.args as never,
    })
  );

  // retries/interval set explicitly (60 * 3s = 3 minutes) — the default
  // wasn't long enough to cover a real commit/reveal round on Bradbury;
  // see deploy.ts header's second-round note.
  const receipt = await withRateLimitRetry(`${target.name} waitForTransactionReceipt`, () =>
    client.waitForTransactionReceipt({
      hash: txHash as TransactionHash,
      status: TransactionStatus.ACCEPTED,
      retries: 60,
      interval: 3000,
    })
  );

  const statusOk = isAcceptedOrFinalized(receipt);
  const executionFailed = receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR;

  if (!statusOk || executionFailed) {
    const observedStatus =
      receipt.statusName ?? (receipt as unknown as { status_name?: string }).status_name ?? receipt.status;
    throw new Error(
      `${target.name} deployment failed — status: ${observedStatus}, ` +
        `execution: ${receipt.txExecutionResultName ?? "unknown"}. ` +
        `Full receipt: ${safeStringify(receipt)}`
    );
  }

  return extractDeployedAddress(receipt, target.name);
}
