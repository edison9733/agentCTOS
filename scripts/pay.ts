/**
 * One escrowed x402 payment, start to finish.
 *
 *   npm run pay -- --amount 25
 *   npm run pay -- --amount 25 --settle refund
 *   npm run pay -- --amount 5  --settle reclaim --timeout 60
 *   npm run pay -- --amount 25 --settle hold
 *
 * Flags:
 *   --amount   order size in whole tokens (default 25)
 *   --settle   confirm | refund | reclaim | hold   (default confirm)
 *   --timeout  escrow timeout in seconds, 60..2592000 (default 3600)
 *   --merchant pay an existing merchant address instead of a generated one
 *   --mint     required with --merchant: the token to pay in
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
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { X402Scoring } from "../target/types/x402_scoring";

function loadProgram(provider: anchor.AnchorProvider): Program<X402Scoring> {
  const root = path.join(__dirname, "..");
  const idl = JSON.parse(
    fs.readFileSync(path.join(root, "target", "idl", "x402_scoring.json"), "utf8")
  );
  const programId = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(path.join(root, "target", "deploy", "x402_scoring-keypair.json"), "utf8")
      )
    )
  ).publicKey;
  return new anchor.Program(idl, programId, provider) as Program<X402Scoring>;
}

// Must match TREASURY in programs/x402-scoring/src/lib.rs. Compiled into the
// program, so it cannot be redirected by a caller.
const TREASURY = new PublicKey("5i7zzV9hQUCbpg8MXSNJB3QQkL6zscDd8VQKow46vg7E");

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

const step = (n: number, title: string) => console.log(`\n[${n}] ${title}`);
const kv = (label: string, value: string) => console.log(`      ${label.padEnd(20)} ${value}`);

async function main() {
  const amount = Number(arg("amount", "25"));
  const settle = (arg("settle", "confirm") as string).toLowerCase();
  const timeoutSeconds = Number(arg("timeout", "3600"));
  const merchantArg = arg("merchant");
  const mintArg = arg("mint");

  if (!["confirm", "refund", "reclaim", "hold"].includes(settle)) {
    throw new Error(`--settle must be confirm | refund | reclaim | hold (got "${settle}")`);
  }
  if (settle === "reclaim" && timeoutSeconds > 300) {
    throw new Error(`--settle reclaim waits out the timeout; use --timeout 60, not ${timeoutSeconds}`);
  }
  if (merchantArg && !mintArg) {
    throw new Error("--merchant also needs --mint: this program keeps no merchant record to look one up from");
  }
  if (merchantArg && settle === "refund") {
    throw new Error("--settle refund needs the merchant's signature, so it only works with a generated merchant");
  }

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
  console.log(" x402 ESCROWED PAYMENT");
  console.log("=".repeat(72));
  kv("network", rpcUrl);
  kv("program", program.programId.toBase58());
  kv("buyer", buyer.publicKey.toBase58());

  // ---------------------------------------------------------------- setup
  let mint: PublicKey;
  let merchant: PublicKey;
  let merchantKey: Keypair | null = null;

  if (merchantArg) {
    step(1, "Paying an existing merchant");
    mint = new PublicKey(mintArg!);
    merchant = new PublicKey(merchantArg);
  } else {
    step(1, "Minting a demo token and generating a merchant");
    mint = await createMint(provider.connection, buyer, provider.wallet.publicKey, null, DECIMALS);
    merchantKey = Keypair.generate();
    merchant = merchantKey.publicKey;
  }

  const buyerToken = merchantArg
    ? (await getOrCreateAssociatedTokenAccount(provider.connection, buyer, mint, buyer.publicKey)).address
    : await createAccount(provider.connection, buyer, mint, buyer.publicKey, Keypair.generate());

  if (!merchantArg) {
    await mintTo(
      provider.connection,
      buyer,
      mint,
      buyerToken,
      provider.wallet.publicKey,
      BigInt(unit(amount * 4).toString())
    );
  }
  const merchantToken = (
    await getOrCreateAssociatedTokenAccount(provider.connection, buyer, mint, merchant, true)
  ).address;
  const treasuryToken = (
    await getOrCreateAssociatedTokenAccount(provider.connection, buyer, mint, TREASURY, true)
  ).address;

  kv("mint", mint.toBase58());
  kv("merchant", merchant.toBase58());
  kv("buyer balance", fmt((await getAccount(provider.connection, buyerToken)).amount));

  // -------------------------------------------------------------- payment
  step(2, `initiate_payment — ${amount.toFixed(3)} tokens, fully escrowed`);
  const orderId = new BN(Date.now() % 1_000_000_000);
  const payment = paymentPda(merchant, orderId);
  const vault = vaultPda(payment);

  const paySig = await program.methods
    .initiatePayment(unit(amount), orderId, new BN(timeoutSeconds))
    .accounts({
      payment,
      merchant,
      buyer: buyer.publicKey,
      buyerToken,
      escrowVault: vault,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([buyer])
    .rpc();

  const p: any = await program.account.payment.fetch(payment);
  kv("order_id", orderId.toString());
  kv("payment", payment.toBase58());
  kv("amount", fmt(p.amount));
  kv("vault holds", fmt((await getAccount(provider.connection, vault)).amount));
  kv("merchant has", fmt((await getAccount(provider.connection, merchantToken)).amount));
  kv("expiry", new Date(p.expiry.toNumber() * 1000).toISOString());
  kv("tx", explorer("tx", paySig, rpcUrl));

  if (settle === "hold") {
    step(3, "Leaving the escrow open (--settle hold)");
    kv("payment", explorer("address", payment.toBase58(), rpcUrl));
    return;
  }

  // ----------------------------------------------------------- settlement
  let sig: string;
  if (settle === "confirm") {
    step(3, "confirm_delivery — buyer releases the escrow");
    sig = await program.methods
      .confirmDelivery(orderId)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vault,
        merchantToken,
        treasuryToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
  } else if (settle === "refund") {
    step(3, "refund_escrow — merchant returns the money");
    sig = await program.methods
      .refundEscrow(orderId)
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        escrowVault: vault,
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([merchantKey!, buyer])
      .rpc();
  } else {
    const waitMs = Math.max(0, p.expiry.toNumber() * 1000 - Date.now()) + 2_000;
    step(3, `Waiting ${Math.ceil(waitMs / 1000)}s for expiry, then reclaiming`);
    await new Promise((r) => setTimeout(r, waitMs));
    sig = await program.methods
      .reclaimTimeout(orderId)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vault,
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
  }

  const p1: any = await program.account.payment.fetch(payment);
  kv("status", Object.keys(p1.status)[0]);
  kv("settlement fee", `${fmt(p1.feeAmount)}  (0.50%, only on success)`);
  kv("merchant has", fmt((await getAccount(provider.connection, merchantToken)).amount));
  kv("buyer balance", fmt((await getAccount(provider.connection, buyerToken)).amount));
  kv("tx", explorer("tx", sig, rpcUrl));

  step(4, "close_payment — reclaim the order record's rent");
  const closeSig = await program.methods
    .closePayment(orderId)
    .accounts({ payment, buyer: buyer.publicKey })
    .signers([buyer])
    .rpc();
  kv("tx", explorer("tx", closeSig, rpcUrl));
  kv("payment", "closed; its history remains as an on-chain event");
}

main().catch((e) => {
  console.error("\nPayment failed:", e);
  process.exit(1);
});
