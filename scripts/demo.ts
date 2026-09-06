/**
 * Agent CTOS anti-rug escrow — live demo script.
 *
 * Registers two merchants (a brand-new one and a "proven" one seeded with a
 * clean settlement history), then runs a handful of real on-chain
 * transactions that show the /verify-time decision tree making a different
 * call for each: full escrow for the new merchant, a small scaled reserve
 * for the proven one, a forced full escrow when a payment blows past that
 * merchant's own history, and a buyer-initiated refund.
 *
 * Every step prints the transaction signature and a clickable Solana
 * Explorer link, plus the on-chain Merchant/Payment PDA state right after —
 * nothing shown here is computed off-chain; it's all re-fetched from the
 * program's own accounts.
 *
 * Usage:
 *   anchor build                 # once, so target/idl + target/types exist
 *   npm run demo                 # defaults to devnet + your local CLI wallet
 *
 *   # to rehearse against a local validator instead:
 *   solana-test-validator &
 *   anchor deploy --provider.cluster localnet
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npm run demo
 */

import * as os from "os";

process.env.ANCHOR_WALLET =
  process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`;
process.env.ANCHOR_PROVIDER_URL =
  process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { X402Scoring } from "../target/types/x402_scoring";

// anchor.workspace.X402Scoring mis-derives the IDL filename for program
// names containing digits (it produces `x_402_scoring.json` instead of the
// real `x402_scoring.json`), so the IDL is loaded directly instead.
function loadProgram(provider: anchor.AnchorProvider): Program<X402Scoring> {
  const idlPath = path.join(__dirname, "..", "target", "idl", "x402_scoring.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = new PublicKey(idl.metadata.address);
  return new anchor.Program(idl, programId, provider) as Program<X402Scoring>;
}

const DECIMALS = 6;
const unit = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));
const fmt = (n: BN) => (n.toNumber() / 10 ** DECIMALS).toFixed(3);

let stepNum = 0;
let stepTotal = 0;
function step(label: string) {
  stepNum += 1;
  console.log(`\n[${stepNum}/${stepTotal}] ${label}`);
}

function explorerTxLink(sig: string, rpcUrl: string): string {
  if (rpcUrl.includes("devnet")) return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  if (rpcUrl.includes("testnet")) return `https://explorer.solana.com/tx/${sig}?cluster=testnet`;
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
    return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  }
  return `https://explorer.solana.com/tx/${sig}`;
}

function explorerAddressLink(addr: PublicKey, rpcUrl: string): string {
  if (rpcUrl.includes("devnet")) return `https://explorer.solana.com/address/${addr.toBase58()}?cluster=devnet`;
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
    return `https://explorer.solana.com/address/${addr.toBase58()}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  }
  return `https://explorer.solana.com/address/${addr.toBase58()}`;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = loadProgram(provider);
  const rpcUrl = provider.connection.rpcEndpoint;

  console.log("=================================================================");
  console.log(" Agent CTOS — x402 anti-rug escrow live demo");
  console.log(`   RPC:      ${rpcUrl}`);
  console.log(`   Program:  ${program.programId.toBase58()}`);
  console.log(`   Wallet:   ${provider.wallet.publicKey.toBase58()}`);
  console.log("=================================================================");

  // The provider's own funded CLI wallet plays the buyer, so this script
  // never depends on a devnet SOL/USDC faucet — only your own `solana
  // airdrop` from setup.
  const buyer = (provider.wallet as anchor.Wallet).payer;

  const newMerchant = Keypair.generate();
  const provenMerchant = Keypair.generate();

  const merchantPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("merchant"), owner.toBuffer()],
      program.programId
    )[0];

  const paymentPda = (merchant: PublicKey, orderId: BN) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("payment"),
        buyer.publicKey.toBuffer(),
        merchant.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

  const vaultPda = (payment: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), payment.toBuffer()],
      program.programId
    )[0];

  async function printMerchant(label: string, pda: PublicKey) {
    const m = (await program.account.merchant.fetch(pda)) as any;
    console.log(
      `   ${label} PDA ${pda.toBase58()}\n` +
        `      tier=${m.tier}  completed_tx=${m.completedTxCount}  avg_tx_size=${fmt(
          m.avgTxSize as BN
        )}  refunds=${m.refundCount}  reclaims=${m.reclaimCount}`
    );
    console.log(`      ${explorerAddressLink(pda, rpcUrl)}`);
  }

  function printPaymentDecision(p: any) {
    console.log(
      `      amount=${fmt(p.amount)}  escrow=${fmt(p.escrowAmount)}  instant=${fmt(
        p.instantAmount
      )}  forced_full_escrow=${p.forcedFullEscrow}  tier_at_payment=${p.tierAtPayment}`
    );
  }

  async function send(label: string, methodBuilder: any): Promise<string> {
    const sig: string = await methodBuilder.rpc();
    console.log(`      tx: ${label} -> ${sig}`);
    console.log(`      ${explorerTxLink(sig, rpcUrl)}`);
    return sig;
  }

  stepTotal = 11;

  // ---------------------------------------------------------------------
  step("Create a demo SPL mint (6 decimals) and fund the buyer");
  const mint = await createMint(
    provider.connection,
    buyer,
    provider.wallet.publicKey,
    null,
    DECIMALS
  );
  const buyerToken = await createAccount(provider.connection, buyer, mint, buyer.publicKey);
  await mintTo(provider.connection, buyer, mint, buyerToken, provider.wallet.publicKey, BigInt(unit(100_000).toString()));
  console.log(`   mint: ${mint.toBase58()}`);
  console.log(`   buyer token account: ${buyerToken.toBase58()} (100,000 demo tokens)`);

  // ---------------------------------------------------------------------
  step("Register merchant 'Aria' — brand new, tier 1, zero history");
  const ariaPda = merchantPda(newMerchant.publicKey);
  const ariaToken = await createAccount(provider.connection, buyer, mint, newMerchant.publicKey);
  await send(
    "register_merchant(Aria)",
    program.methods.registerMerchant().accounts({
      merchant: ariaPda,
      owner: newMerchant.publicKey,
      systemProgram: SystemProgram.programId,
    }).signers([newMerchant])
  );
  await printMerchant("Aria", ariaPda);

  // ---------------------------------------------------------------------
  step("Register merchant 'Nova' — will be seeded with a clean history");
  const novaPda = merchantPda(provenMerchant.publicKey);
  const novaToken = await createAccount(provider.connection, buyer, mint, provenMerchant.publicKey);
  await send(
    "register_merchant(Nova)",
    program.methods.registerMerchant().accounts({
      merchant: novaPda,
      owner: provenMerchant.publicKey,
      systemProgram: SystemProgram.programId,
    }).signers([provenMerchant])
  );

  // ---------------------------------------------------------------------
  step("Seed Nova with 5 clean $10 orders so it mechanically promotes to tier 2");
  let orderId = 1;
  for (let i = 0; i < 5; i++) {
    const id = new BN(orderId++);
    const amount = unit(10);
    const payment = paymentPda(novaPda, id);
    const vault = vaultPda(payment);
    await send(
      `initiate_payment(Nova, seed #${i + 1})`,
      program.methods.initiatePayment(amount, id, new BN(3600)).accounts({
        payment,
        merchant: novaPda,
        buyer: buyer.publicKey,
        buyerToken,
        merchantToken: novaToken,
        escrowVault: vault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      }).signers([buyer])
    );
    await send(
      `confirm_delivery(Nova, seed #${i + 1})`,
      program.methods.confirmDelivery(id).accounts({
        payment,
        merchant: novaPda,
        buyer: buyer.publicKey,
        escrowVault: vault,
        merchantToken: novaToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([buyer])
    );
  }
  await printMerchant("Nova", novaPda);
  console.log("   -> Nova is now tier 2 ('proven'), purely from settlement history.");

  // ---------------------------------------------------------------------
  step("DECISION #1 — Aria (new/tier 1): pay $20, expect 100% escrow");
  const ariaOrder1 = new BN(1);
  const ariaAmount1 = unit(20);
  const ariaPayment1 = paymentPda(ariaPda, ariaOrder1);
  const ariaVault1 = vaultPda(ariaPayment1);
  await send(
    "initiate_payment(Aria, $20)",
    program.methods.initiatePayment(ariaAmount1, ariaOrder1, new BN(3600)).accounts({
      payment: ariaPayment1,
      merchant: ariaPda,
      buyer: buyer.publicKey,
      buyerToken,
      merchantToken: ariaToken,
      escrowVault: ariaVault1,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    }).signers([buyer])
  );
  printPaymentDecision(await program.account.payment.fetch(ariaPayment1));

  // ---------------------------------------------------------------------
  step("Buyer confirms delivery — Aria's escrow releases, order counts toward her history");
  await send(
    "confirm_delivery(Aria, order 1)",
    program.methods.confirmDelivery(ariaOrder1).accounts({
      payment: ariaPayment1,
      merchant: ariaPda,
      buyer: buyer.publicKey,
      escrowVault: ariaVault1,
      merchantToken: ariaToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([buyer])
  );
  await printMerchant("Aria", ariaPda);

  // ---------------------------------------------------------------------
  step("DECISION #2 — Nova (tier 2): pay $15, an in-range order vs. her $10 average");
  const novaOrder1 = new BN(6);
  const novaAmount1 = unit(15);
  const novaPayment1 = paymentPda(novaPda, novaOrder1);
  const novaVault1 = vaultPda(novaPayment1);
  await send(
    "initiate_payment(Nova, $15)",
    program.methods.initiatePayment(novaAmount1, novaOrder1, new BN(3600)).accounts({
      payment: novaPayment1,
      merchant: novaPda,
      buyer: buyer.publicKey,
      buyerToken,
      merchantToken: novaToken,
      escrowVault: novaVault1,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    }).signers([buyer])
  );
  const novaDecision1 = await program.account.payment.fetch(novaPayment1);
  printPaymentDecision(novaDecision1);
  console.log("   -> Most of the payment went straight to Nova instantly; only a small reserve is held.");

  // ---------------------------------------------------------------------
  step("Buyer confirms delivery — Nova's small reserve releases too");
  await send(
    "confirm_delivery(Nova, order 6)",
    program.methods.confirmDelivery(novaOrder1).accounts({
      payment: novaPayment1,
      merchant: novaPda,
      buyer: buyer.publicKey,
      escrowVault: novaVault1,
      merchantToken: novaToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([buyer])
  );

  // ---------------------------------------------------------------------
  step("DECISION #3 — Nova (tier 2): a sudden $500 bid vs. her $10 average (50x jump)");
  const novaOrder2 = new BN(7);
  const novaAmount2 = unit(500);
  const novaPayment2 = paymentPda(novaPda, novaOrder2);
  const novaVault2 = vaultPda(novaPayment2);
  await send(
    "initiate_payment(Nova, $500 anomaly)",
    program.methods.initiatePayment(novaAmount2, novaOrder2, new BN(3600)).accounts({
      payment: novaPayment2,
      merchant: novaPda,
      buyer: buyer.publicKey,
      buyerToken,
      merchantToken: novaToken,
      escrowVault: novaVault2,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    }).signers([buyer])
  );
  const novaDecision2 = (await program.account.payment.fetch(novaPayment2)) as any;
  printPaymentDecision(novaDecision2);
  console.log(
    novaDecision2.forcedFullEscrow
      ? "   -> Rule 2/3/10 triggered: tier 2's 10x multiplier caps orders at $100. $500 forced to 100% escrow."
      : "   -> unexpected: anomaly rule did not trigger"
  );

  // ---------------------------------------------------------------------
  step("Buyer decides not to wait — refunds the anomalous $500 order instead of confirming");
  await send(
    "refund_escrow(Nova, order 7)",
    program.methods.refundEscrow(novaOrder2).accounts({
      payment: novaPayment2,
      merchant: novaPda,
      buyer: buyer.publicKey,
      escrowVault: novaVault2,
      buyerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([buyer])
  );
  await printMerchant("Nova", novaPda);
  console.log("   -> Refund recorded on-chain; Nova's refund rate is now part of her public history.");

  // ---------------------------------------------------------------------
  step("Anyone can independently re-verify tier assignment — permissionless recompute");
  await send(
    "recompute_tier(Nova)",
    program.methods.recomputeTier().accounts({ merchant: novaPda })
  );
  await printMerchant("Nova", novaPda);

  console.log("\n=================================================================");
  console.log(" Demo complete. Every number above came from the on-chain Merchant");
  console.log(" and Payment PDAs printed next to each step — click the Explorer");
  console.log(" links to verify independently.");
  console.log("=================================================================\n");
}

main().catch((err) => {
  console.error("\nDemo failed:", err);
  process.exit(1);
});
