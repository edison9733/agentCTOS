/**
 * One x402 payment, start to finish.
 *
 * The demo runs a scripted five-act narrative. This runs a single real
 * payment through the same program so you can drive the flow yourself and
 * watch each account change:
 *
 *   register_merchant -> initiate_payment -> (confirm | refund | reclaim)
 *
 * Usage:
 *   npm run pay -- --amount 25
 *   npm run pay -- --amount 25 --settle refund
 *   npm run pay -- --amount 25 --settle reclaim --timeout 60
 *   npm run pay -- --amount 25 --merchant <MERCHANT_OWNER_PUBKEY>
 *
 * Flags:
 *   --amount   order size in whole tokens (default 25)
 *   --settle   confirm | refund | reclaim | hold   (default confirm)
 *   --timeout  escrow timeout in seconds, 60..2592000 (default 3600)
 *   --merchant reuse an existing merchant by owner pubkey; omit to create a
 *              brand-new one (which, per rule 4, starts at tier 1)
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
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { X402Scoring } from "../target/types/x402_scoring";

function loadProgram(provider: anchor.AnchorProvider): Program<X402Scoring> {
  const idlPath = path.join(__dirname, "..", "target", "idl", "x402_scoring.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const keypairPath = path.join(__dirname, "..", "target", "deploy", "x402_scoring-keypair.json");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")));
  const programId = Keypair.fromSecretKey(secretKey).publicKey;
  return new anchor.Program(idl, programId, provider) as Program<X402Scoring>;
}

const DECIMALS = 6;
const unit = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));
const fmt = (n: BN | bigint | number) => {
  const v = typeof n === "bigint" ? Number(n) : typeof n === "number" ? n : n.toNumber();
  return (v / 10 ** DECIMALS).toFixed(3);
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function explorer(kind: "tx" | "address", id: string, rpcUrl: string): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (rpcUrl.includes("devnet")) return `${base}?cluster=devnet`;
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  }
  return base;
}

function step(n: number, title: string) {
  console.log(`\n[${n}] ${title}`);
}

function kv(label: string, value: string) {
  console.log(`      ${label.padEnd(22)} ${value}`);
}

async function main() {
  const amount = Number(arg("amount", "25"));
  const settle = (arg("settle", "confirm") as string).toLowerCase();
  const timeoutSeconds = Number(arg("timeout", "3600"));
  const merchantOwnerArg = arg("merchant");

  if (!["confirm", "refund", "reclaim", "hold"].includes(settle)) {
    throw new Error(`--settle must be confirm | refund | reclaim | hold (got "${settle}")`);
  }
  if (settle === "reclaim" && timeoutSeconds > 300) {
    throw new Error(
      `--settle reclaim waits out the full timeout; use --timeout 60 rather than ${timeoutSeconds}`
    );
  }

  // "confirmed" rather than Anchor's default "processed": each step here
  // depends on the previous one being visible cluster-wide, and a
  // load-balanced RPC will otherwise answer from a node that is behind.
  const env = anchor.AnchorProvider.env();
  const connection = new anchor.web3.Connection(env.connection.rpcEndpoint, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 90_000,
  });
  const provider = new anchor.AnchorProvider(connection, env.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = loadProgram(provider);
  const rpcUrl = provider.connection.rpcEndpoint;
  const buyer = (provider.wallet as anchor.Wallet).payer;

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

  console.log("=".repeat(72));
  console.log(" x402 PAYMENT");
  console.log("=".repeat(72));
  kv("network", rpcUrl);
  kv("program", program.programId.toBase58());
  kv("buyer", buyer.publicKey.toBase58());

  // ---------------------------------------------------------------- token
  //
  // A merchant pins its settlement mint at registration, so reusing one with
  // --merchant has to reuse that same mint too — minting a fresh token each
  // run would be rejected with MintMismatch. The wallet is the mint authority
  // for any mint this script created, so it can top itself up either way.
  let mint: PublicKey;
  if (merchantOwnerArg) {
    const existing: any = await program.account.merchant.fetch(
      merchantPda(new PublicKey(merchantOwnerArg))
    );
    mint = existing.mint;
    step(1, "Reuse the merchant's registered settlement mint");
  } else {
    step(1, "Mint a demo SPL token and fund the buyer");
    mint = await createMint(
      provider.connection,
      buyer,
      provider.wallet.publicKey,
      null,
      DECIMALS
    );
  }

  const buyerToken = await createAccount(
    provider.connection,
    buyer,
    mint,
    buyer.publicKey,
    Keypair.generate()
  );
  await mintTo(
    provider.connection,
    buyer,
    mint,
    buyerToken,
    provider.wallet.publicKey,
    BigInt(unit(amount * 10).toString())
  );
  kv("mint", mint.toBase58());
  kv("buyer balance", fmt((await getAccount(provider.connection, buyerToken)).amount));

  // ------------------------------------------------------------- merchant
  let merchantOwner: Keypair | null = null;
  let merchant: PublicKey;

  if (merchantOwnerArg) {
    merchant = merchantPda(new PublicKey(merchantOwnerArg));
    step(2, "Reuse the existing merchant");
    kv("merchant PDA", merchant.toBase58());
  } else {
    merchantOwner = Keypair.generate();
    merchant = merchantPda(merchantOwner.publicKey);

    step(2, "Register a brand-new merchant");
    // register_merchant has `payer = owner`, so the owner needs lamports of
    // its own before it can sign for the PDA's rent.
    const fundSig = await provider.connection.requestAirdrop(
      merchantOwner.publicKey,
      0.02 * anchor.web3.LAMPORTS_PER_SOL
    ).catch(async () => {
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: buyer.publicKey,
          toPubkey: merchantOwner!.publicKey,
          lamports: 0.02 * anchor.web3.LAMPORTS_PER_SOL,
        })
      );
      return provider.sendAndConfirm(tx, [buyer]);
    });
    await provider.connection.confirmTransaction(fundSig as string, "confirmed").catch(() => {});

    const sig = await program.methods
      .registerMerchant()
      .accounts({
        merchant,
        owner: merchantOwner.publicKey,
        mint,
        systemProgram: SystemProgram.programId,
      })
      .signers([merchantOwner])
      .rpc();
    kv("merchant PDA", merchant.toBase58());
    kv("owner", merchantOwner.publicKey.toBase58());
    kv("tx", explorer("tx", sig, rpcUrl));
  }

  const merchantToken = await createAccount(
    provider.connection,
    buyer,
    mint,
    merchantOwner ? merchantOwner.publicKey : new PublicKey(merchantOwnerArg!),
    Keypair.generate()
  );

  const m0: any = await program.account.merchant.fetch(merchant);
  kv("tier", String(m0.tier));
  kv("completed_tx_count", m0.completedTxCount.toString());
  kv("avg_tx_size", fmt(m0.avgTxSize));

  // -------------------------------------------------------------- payment
  step(3, `initiate_payment — ${amount.toFixed(3)} tokens`);
  const orderId = new BN(Date.now() % 1_000_000);
  const payment = paymentPda(merchant, orderId);
  const vault = vaultPda(payment);

  const paySig = await program.methods
    .initiatePayment(unit(amount), orderId, new BN(timeoutSeconds))
    .accounts({
      payment,
      merchant,
      buyer: buyer.publicKey,
      buyerToken,
      merchantToken,
      escrowVault: vault,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([buyer])
    .rpc();

  const p: any = await program.account.payment.fetch(payment);
  const pct = ((p.escrowAmount.toNumber() / p.amount.toNumber()) * 100).toFixed(1);
  kv("order_id", orderId.toString());
  kv("payment PDA", payment.toBase58());
  kv("escrow_amount", `${fmt(p.escrowAmount)}  (${pct}% held in the vault)`);
  kv("instant_amount", `${fmt(p.instantAmount)}  (sent to the merchant now)`);
  kv("tier_at_payment", String(p.tierAtPayment));
  kv("forced_full_escrow", String(p.forcedFullEscrow));
  kv("expiry", new Date(p.expiry.toNumber() * 1000).toISOString());
  kv("tx", explorer("tx", paySig, rpcUrl));
  kv("vault holds", fmt((await getAccount(provider.connection, vault)).amount));

  if (settle === "hold") {
    step(4, "Leaving the escrow open (--settle hold)");
    kv("payment PDA", explorer("address", payment.toBase58(), rpcUrl));
    kv("merchant PDA", explorer("address", merchant.toBase58(), rpcUrl));
    return;
  }

  // ------------------------------------------------------------ settlement
  if (settle === "reclaim") {
    const waitMs = Math.max(0, p.expiry.toNumber() * 1000 - Date.now()) + 2_000;
    step(4, `Waiting ${Math.ceil(waitMs / 1000)}s for the escrow to expire, then reclaiming`);
    await new Promise((r) => setTimeout(r, waitMs));
  } else {
    step(4, settle === "confirm" ? "confirm_delivery" : "refund_escrow");
  }

  let settleSig: string;
  if (settle === "confirm") {
    settleSig = await program.methods
      .confirmDelivery(orderId)
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        escrowVault: vault,
        merchantToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
  } else if (settle === "refund") {
    settleSig = await program.methods
      .refundEscrow(orderId)
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        escrowVault: vault,
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
  } else {
    settleSig = await program.methods
      .reclaimTimeout(orderId)
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        escrowVault: vault,
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
  }

  const p1: any = await program.account.payment.fetch(payment);
  const m1: any = await program.account.merchant.fetch(merchant);

  kv("tx", explorer("tx", settleSig, rpcUrl));
  kv("payment status", Object.keys(p1.status)[0]);
  kv("merchant received", fmt((await getAccount(provider.connection, merchantToken)).amount));
  kv("buyer balance", fmt((await getAccount(provider.connection, buyerToken)).amount));

  step(5, "Merchant state, re-read from chain");
  kv("tier", `${m0.tier} → ${m1.tier}`);
  kv("completed_tx_count", `${m0.completedTxCount} → ${m1.completedTxCount}`);
  kv("avg_tx_size", `${fmt(m0.avgTxSize)} → ${fmt(m1.avgTxSize)}`);
  kv("refund_count", m1.refundCount.toString());
  kv("reclaim_count", m1.reclaimCount.toString());
  kv("tier_floor_tx_count", m1.tierFloorTxCount.toString());

  console.log("");
  kv("merchant PDA", explorer("address", merchant.toBase58(), rpcUrl));
  kv("payment PDA", explorer("address", payment.toBase58(), rpcUrl));
  if (merchantOwner) {
    console.log("");
    console.log(`   Reuse this merchant to build its history:`);
    console.log(`     npm run pay -- --amount ${amount} --merchant ${merchantOwner.publicKey.toBase58()}`);
  }
}

main().catch((e) => {
  console.error("\nPayment failed:", e);
  process.exit(1);
});
