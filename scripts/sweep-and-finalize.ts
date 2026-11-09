// scripts/sweep-and-finalize.ts
//
// Master Treasury Rescue & Sweep Script
// Sweeps stuck or remaining GEN from any Nuance Intelligent Contract
// (NuanceEscrow, NuancePredictionMarket, NuanceDisputeCourt, NuanceGovernance)
// back to the Master Treasury: 0x41648dE45Cc4D0172beCd4Db0A0A0b459C383705
//
// Usage:
//   npx tsx scripts/sweep-and-finalize.ts <contract_address> [amount_wei]
//   npx tsx scripts/sweep-and-finalize.ts --all

import { createAccount, createClient, chains } from "genlayer-js";
import { TransactionStatus, type TransactionHash } from "genlayer-js/types";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";

setDefaultResultOrder("ipv4first");

const MASTER_TREASURY = "0x41648dE45Cc4D0172beCd4Db0A0A0b459C383705" as `0x${string}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BACKEND_ENV_PATH = resolve(REPO_ROOT, "backend/.env");

function loadEnvFile(path: string): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
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

async function sweepContract(
  client: ReturnType<typeof createClient>,
  contractAddress: `0x${string}`,
  amount: bigint = BigInt(0)
) {
  console.log(`\n========================================================`);
  console.log(`Sweeping Contract: ${contractAddress}`);
  console.log(`Master Treasury:   ${MASTER_TREASURY}`);
  console.log(`========================================================`);

  // 1. Read before balances
  const contractBalanceBefore = BigInt(await client.getBalance({ address: contractAddress }));
  const treasuryBalanceBefore = BigInt(await client.getBalance({ address: MASTER_TREASURY }));

  console.log(`\n--- Before Balance ---`);
  console.log(`  Contract: ${formatGen(contractBalanceBefore)}`);
  console.log(`  Treasury: ${formatGen(treasuryBalanceBefore)}`);

  if (contractBalanceBefore === BigInt(0) && amount === BigInt(0)) {
    console.log(`\nℹ Notice: Contract balance is currently 0 GEN.`);
  }

  console.log(`\nInitiating emergency_withdraw(amount=${amount}, to_address="${MASTER_TREASURY}")…`);

  // 2. Dispatch emergency_withdraw
  const distribution = await client.estimateFeesDistribution({});
  const txHash = await client.writeContract({
    address: contractAddress,
    functionName: "emergency_withdraw",
    args: [amount, MASTER_TREASURY] as never,
    value: BigInt(0),
    fees: { distribution, feeValue: BigInt("100000000000010352") },
  });

  console.log(`  Tx Hash: ${txHash}`);
  console.log(`  Waiting for transaction to reach FINALIZED on GenLayer…`);

  // 3. Track through transaction finality
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash as TransactionHash,
    status: TransactionStatus.FINALIZED,
    retries: 60,
    interval: 3000,
  });

  const statusName =
    receipt.statusName ??
    (receipt as unknown as { status_name?: string }).status_name ??
    receipt.status;
  console.log(`  Receipt Status: ${statusName}`);

  // 4. Read after balances
  const contractBalanceAfter = BigInt(await client.getBalance({ address: contractAddress }));
  const treasuryBalanceAfter = BigInt(await client.getBalance({ address: MASTER_TREASURY }));

  console.log(`\n--- After Balance ---`);
  console.log(`  Contract: ${formatGen(contractBalanceAfter)}`);
  console.log(`  Treasury: ${formatGen(treasuryBalanceAfter)}`);

  const deltaTreasury = treasuryBalanceAfter - treasuryBalanceBefore;
  console.log(`\n✓ Sweep Completed! Treasury Delta: +${formatGen(deltaTreasury)}`);
}

async function main() {
  loadEnvFile(BACKEND_ENV_PATH);

  const privateKey = process.env.GENLAYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(`GENLAYER_PRIVATE_KEY not found in ${BACKEND_ENV_PATH}`);
  }

  const account = createAccount(privateKey as `0x${string}`);
  const client = createClient({
    chain: chains.testnetBradbury,
    account,
  });

  console.log(`Caller / Admin: ${account.address}`);
  console.log(`Target Treasury: ${MASTER_TREASURY}`);

  const targetArg = process.argv[2];

  if (!targetArg || targetArg === "--help" || targetArg === "-h") {
    console.log(`
Usage:
  npx tsx scripts/sweep-and-finalize.ts <contract_address> [amount_wei]
  npx tsx scripts/sweep-and-finalize.ts --all
    `);
    process.exit(0);
  }

  if (targetArg === "--all") {
    const contracts: `0x${string}`[] = [];
    if (process.env.ESCROW_CONTRACT_ADDRESS) contracts.push(process.env.ESCROW_CONTRACT_ADDRESS as `0x${string}`);
    if (process.env.PREDICTION_MARKET_CONTRACT_ADDRESS) contracts.push(process.env.PREDICTION_MARKET_CONTRACT_ADDRESS as `0x${string}`);
    if (process.env.DISPUTE_COURT_CONTRACT_ADDRESS) contracts.push(process.env.DISPUTE_COURT_CONTRACT_ADDRESS as `0x${string}`);
    if (process.env.GOVERNANCE_CONTRACT_ADDRESS) contracts.push(process.env.GOVERNANCE_CONTRACT_ADDRESS as `0x${string}`);

    console.log(`Sweeping all configured contracts from env (${contracts.length} total)…`);
    for (const c of contracts) {
      try {
        await sweepContract(client, c, BigInt(0));
      } catch (err) {
        console.error(`Failed to sweep ${c}:`, err);
      }
    }
    return;
  }

  const contractAddress = targetArg as `0x${string}`;
  const amount = process.argv[3] ? BigInt(process.argv[3]) : BigInt(0);

  await sweepContract(client, contractAddress, amount);
}

main().catch((err) => {
  console.error("Sweep script error:", err);
  process.exit(1);
});
