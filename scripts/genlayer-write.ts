// scripts/genlayer-write.ts — closing the dispute-adjudication gap.
//
// A thin write bridge invoked as a subprocess by backend/app/services/
// genlayer_write.py — fires a single writeContract call using the
// backend's own deployer key (the exact same GENLAYER_PRIVATE_KEY
// scripts/deploy.ts and scripts/genlayer-deploy.ts already use), and
// returns the transaction hash without waiting for it to be accepted or
// finalized — services/genlayer_indexer.py's own existing poll cycle
// discovers the result afterward via its normal get_dispute view-sync,
// exactly the same way it already does for every other on-chain write
// this app tracks. No receipt wait here at all, unlike scripts/
// genlayer-deploy.ts (a deploy needs the address back from the receipt;
// this doesn't need anything back but the hash).
//
// Built for one specific call: NuanceDisputeCourt.adjudicate_dispute,
// which has NO sender restriction at all (see that contract's own
// source) — GenVM's validator network does the actual judging regardless
// of which address sends the call, so the backend triggering it
// automatically isn't a meaningfully different trust boundary than any
// other address doing so. This is NOT a general "sign anything" bridge —
// it's only ever invoked from genlayer_indexer.py's
// trigger_pending_adjudications, which always passes a fixed,
// hardcoded functionName, never anything caller-supplied from outside
// that one code path.
//
// Protocol: one JSON object on stdin —
//   { "address": "0x...", "functionName": "adjudicate_dispute", "args": [...] }
// — one JSON object on stdout —
//   { "ok": true, "txHash": "0x..." } | { "ok": false, "error": "..." }

import { createAccount, createClient, chains } from "genlayer-js";
import type { TransactionFeeOptions } from "genlayer-js/types";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { withRateLimitRetry, safeStringify, REPO_ROOT } from "./genlayer-deploy-core";

const BACKEND_ENV_PATH = resolve(REPO_ROOT, "backend/.env");

function loadEnvFile(path: string): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

interface WriteRequest {
  address: string;
  functionName: string;
  args: unknown[];
}

async function main() {
  loadEnvFile(BACKEND_ENV_PATH);
  const privateKey = process.env.GENLAYER_PRIVATE_KEY;
  if (!privateKey) {
    process.stdout.write(
      safeStringify({ ok: false, error: `GENLAYER_PRIVATE_KEY not set in ${BACKEND_ENV_PATH}.` })
    );
    return;
  }

  const raw = await readStdin();
  const request = JSON.parse(raw) as WriteRequest;

  const account = createAccount(privateKey as `0x${string}`);
  const client = createClient({
    chain: chains.testnetBradbury,
    account,
    endpoint: "https://rpc-bradbury.genlayer.com",
  });

  try {
    let fees: TransactionFeeOptions | undefined;
    try {
      const estimated = await client.estimateTransactionFees({});
      if (estimated?.feeValue && estimated.feeValue > BigInt(0)) {
        fees = {
          distribution: estimated.distribution,
          feeValue: estimated.feeValue,
        };
      }
    } catch {
      fees = {
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
    }

    const txHash = await withRateLimitRetry(`writeContract ${request.functionName}`, () =>
      client.writeContract({
        address: request.address as `0x${string}`,
        functionName: request.functionName,
        args: (request.args ?? []) as never,
        value: BigInt(0),
        fees,
      })
    );
    process.stdout.write(safeStringify({ ok: true, txHash: String(txHash) }));
  } catch (err) {
    // Per-request ok:false in a normally-exiting JSON body, not a thrown
    // process failure — same principle as genlayer-read.ts/
    // genlayer-deploy.ts. The Python caller treats this as "didn't send,
    // safe to retry next cycle," not a crash.
    process.stdout.write(safeStringify({ ok: false, error: errorMessage(err) }));
  }
}

main().catch((err) => {
  process.stderr.write(`genlayer-write fatal: ${errorMessage(err)}\n`);
  process.exitCode = 1;
});
