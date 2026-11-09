// scripts/canary-fund.ts
//
// Canary Funding Script
// Funds a deployed NuanceEscrow contract with native GEN (e.g., 0.01 GEN)
// and confirms receipt on-chain using client.getBalance.
//
// Usage:
//   npx tsx scripts/canary-fund.ts <contract_address> [amount_gen]

import { createAccount, createClient, chains } from "genlayer-js";
import { TransactionStatus, type TransactionHash } from "genlayer-js/types";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { withRateLimitRetry } from "./genlayer-deploy-core";

setDefaultResultOrder("ipv4first");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BACKEND_ENV_PATH = resolve(REPO_ROOT, "backend/.env");

function loadEnvFile(path: string): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

function parseGenToWei(gen: string | number): bigint {
  const [whole, frac = ""] = String(gen).split(".");
  const fracPadded = frac.padEnd(18, "0").slice(0, 18);
  const fullStr = `${whole}${fracPadded}`.replace(/^0+/, "") || "0";
  return BigInt(fullStr);
}

function formatGen(wei: bigint): string {
  const etherStr = wei.toString();
  if (wei === BigInt(0)) return "0 GEN";
  if (etherStr.length <= 18) {
    const padded = etherStr.padStart(18, "0");
    const formatted = `0.${padded}`.replace(/\.?0+$/, "");
    return `${formatted} GEN (${wei} wei)`;
  }
  const whole = etherStr.slice(0, etherStr.length - 18);
  const frac = etherStr.slice(etherStr.length - 18).replace(/\.?0+$/, "");
  return frac.length > 0 ? `${whole}.${frac} GEN (${wei} wei)` : `${whole} GEN (${wei} wei)`;
}

async function main() {
  loadEnvFile(BACKEND_ENV_PATH);
  const privateKey = process.env.GENLAYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(`GENLAYER_PRIVATE_KEY not set in ${BACKEND_ENV_PATH}`);
  }

  const contractAddress = process.argv[2] as `0x${string}`;
  if (!contractAddress || !contractAddress.startsWith("0x")) {
    console.error("Usage: npx tsx scripts/canary-fund.ts <contract_address> [amount_gen]");
    process.exit(1);
  }

  const amountGen = process.argv[3] ?? "0.01";
  const amountWei = parseGenToWei(amountGen);

  const account = createAccount(privateKey as `0x${string}`);
  const client = createClient({ chain: chains.testnetBradbury, account });

  console.log(`\n========================================================`);
  console.log(`Canary Funding Test: ${amountGen} GEN -> ${contractAddress}`);
  console.log(`Funder Address:      ${account.address}`);
  console.log(`========================================================`);

  const funderBalBefore = BigInt(await client.getBalance({ address: account.address }));
  const contractBalBefore = BigInt(await client.getBalance({ address: contractAddress }));

  console.log(`\n--- Before Balance ---`);
  console.log(`  Funder Wallet:    ${formatGen(funderBalBefore)}`);
  console.log(`  Target Contract:  ${formatGen(contractBalBefore)}`);

  console.log(`\nSubmitting fund_escrow(value=${formatGen(amountWei)})…`);

  const distribution = await client.estimateFeesDistribution({});
  const txHash = await withRateLimitRetry("canary fund_escrow", () =>
    client.writeContract({
      address: contractAddress,
      functionName: "fund_escrow",
      args: [] as never,
      value: amountWei,
      fees: { distribution, feeValue: BigInt("100000000000010352") },
    })
  );

  console.log(`  Tx Hash: ${txHash}`);
  console.log(`  Waiting for transaction to reach ACCEPTED on GenLayer…`);

  const receipt = await withRateLimitRetry("canary waitForTransactionReceipt", () =>
    client.waitForTransactionReceipt({
      hash: txHash as TransactionHash,
      status: TransactionStatus.ACCEPTED,
      retries: 60,
      interval: 3000,
    })
  );

  const statusName =
    receipt.statusName ??
    (receipt as unknown as { status_name?: string }).status_name ??
    receipt.status;
  console.log(`  Transaction status: ${statusName}`);

  const contractBalAfter = BigInt(await client.getBalance({ address: contractAddress }));
  const funderBalAfter = BigInt(await client.getBalance({ address: account.address }));

  console.log(`\n--- After Balance ---`);
  console.log(`  Funder Wallet:    ${formatGen(funderBalAfter)}`);
  console.log(`  Target Contract:  ${formatGen(contractBalAfter)}`);

  const delta = contractBalAfter - contractBalBefore;
  console.log(`\n✓ Contract balance increased by +${formatGen(delta)}`);
}

main().catch((err) => {
  console.error("Canary fund failed:", err);
  process.exit(1);
});
