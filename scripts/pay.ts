/**
 * One escrowed x402 payment, routed by collateral, start to finish.
 *
 *   npm run pay -- --amount 25
 *   npm run pay -- --amount 60 --reserve 100 --register     # instant, if standing already exists
 *   npm run pay -- --amount 5  --settle reclaim --timeout 60
 *   npm run pay -- --amount 25 --settle claim
 *   npm run pay -- --amount 25 --settle hold
 *
 * Flags:
 *   --amount    order size in whole tokens (default 25)
 *   --settle    confirm | reclaim | claim | hold   (default confirm)
 *   --timeout   escrow timeout in seconds, 60..2592000 (default 3600)
 *   --reserve   have the (generated) merchant open and post this many
 *               tokens of collateral before the order is paid
 *   --register  register the buyer's standing before paying (does not by
 *               itself make a buyer "established" — that only happens once
 *               an order actually settles)
 *   --merchant  pay an existing merchant address instead of a generated one
 *   --mint      required with --merchant: the token to pay in
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
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
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
  const reserveAmount = arg("reserve") ? Number(arg("reserve")) : undefined;
  const registerStanding = flag("register");
  const merchantArg = arg("merchant");
  const mintArg = arg("mint");

  if (!["confirm", "reclaim", "claim", "hold"].includes(settle)) {
    throw new Error(`--settle must be confirm | reclaim | claim | hold (got "${settle}")`);
  }
  if (settle === "reclaim" && timeoutSeconds > 300) {
    throw new Error(`--settle reclaim waits out the timeout; use --timeout 60, not ${timeoutSeconds}`);
  }
  if (merchantArg && !mintArg) {
    throw new Error("--merchant also needs --mint: this program keeps no merchant record to look one up from");
  }
  if (merchantArg && reserveAmount !== undefined) {
    throw new Error("--reserve needs a generated merchant: an existing --merchant's keypair is not held by this script");
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
    PublicKey.findProgramAddressSync([Buffer.from("vault"), payment.toBuffer()], program.programId)[0];
  const reservePda = (merchant: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("reserve"), merchant.toBuffer()], program.programId)[0];
  const reserveVaultPda = (reserve: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("reserve_vault"), reserve.toBuffer()], program.programId)[0];
  const standingPda = (b: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("standing"), b.toBuffer()], program.programId)[0];

  console.log("=".repeat(72));
  console.log(" x402 ESCROWED PAYMENT — ROUTED BY COLLATERAL");
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
    const sig = await provider.connection.requestAirdrop(merchant, 0.05e9);
    await provider.connection.confirmTransaction(sig);
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

  const reserve = reservePda(merchant);
  const reserveVault = reserveVaultPda(reserve);

  if (reserveAmount !== undefined && merchantKey) {
    step(2, `Merchant posts ${reserveAmount.toFixed(3)} tokens of collateral`);
    await program.methods
      .openReserve()
      .accounts({
        reserve,
        merchant,
        reserveVault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([merchantKey])
      .rpc();
    const funding = await createAccount(provider.connection, buyer, mint, merchant, Keypair.generate());
    await mintTo(provider.connection, buyer, mint, funding, provider.wallet.publicKey, BigInt(unit(reserveAmount).toString()));
    await program.methods
      .postReserve(unit(reserveAmount))
      .accounts({ reserve, merchant, reserveVault, merchantToken: funding, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([merchantKey])
      .rpc();
    kv("reserve posted", fmt((await getAccount(provider.connection, reserveVault)).amount));
  }

  if (registerStanding) {
    try {
      await program.methods
        .registerBuyer()
        .accounts({ standing: standingPda(buyer.publicKey), buyer: buyer.publicKey, systemProgram: SystemProgram.programId })
        .signers([buyer])
        .rpc();
      kv("standing", "registered (settled_count starts at 0)");
    } catch (e) {
      kv("standing", "already registered");
    }
  }

  // -------------------------------------------------------------- payment
  step(3, `initiate_payment — ${amount.toFixed(3)} tokens, routed by reserve + standing`);
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
      merchantToken,
      escrowVault: vault,
      merchantReserve: reserve,
      reserveVault,
      buyerStanding: standingPda(buyer.publicKey),
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
  kv("instant / escrowed", `${fmt(p.instantAmount)} / ${fmt(p.escrowedAmount)}`);
  kv("vault holds", fmt((await getAccount(provider.connection, vault)).amount));
  kv("merchant has", fmt((await getAccount(provider.connection, merchantToken)).amount));
  kv("expiry", new Date(p.expiry.toNumber() * 1000).toISOString());
  kv("tx", explorer("tx", paySig, rpcUrl));

  if (settle === "hold") {
    step(4, "Leaving the escrow open (--settle hold)");
    kv("payment", explorer("address", payment.toBase58(), rpcUrl));
    return;
  }

  // ----------------------------------------------------------- settlement
  let sig: string;
  if (settle === "confirm") {
    step(4, "confirm_delivery — buyer releases the escrow");
    sig = await program.methods
      .confirmDelivery(orderId)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vault,
        merchantToken,
        treasuryToken,
        merchantReserve: reserve,
        buyerStanding: standingPda(buyer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
  } else if (settle === "claim") {
    if (!merchantKey) {
      throw new Error("--settle claim needs a generated merchant: this script must hold its keypair to sign the claim");
    }
    step(4, "claim_fulfillment — merchant claims delivery without the buyer confirming");
    sig = await program.methods
      .claimFulfillment(orderId)
      .accounts({ payment, merchant })
      .signers([merchantKey])
      .rpc();
    kv("note", "finalize_claim becomes callable 24h from now, by anyone, if undisputed");
    return;
  } else {
    const waitMs = Math.max(0, p.expiry.toNumber() * 1000 - Date.now()) + 2_000;
    step(4, `Waiting ${Math.ceil(waitMs / 1000)}s for expiry, then reclaiming`);
    await new Promise((r) => setTimeout(r, waitMs));
    sig = await program.methods
      .reclaimTimeout(orderId)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vault,
        buyerToken,
        merchantReserve: reserve,
        reserveVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
  }

  const p1: any = await program.account.payment.fetch(payment);
  kv("status", Object.keys(p1.status)[0]);
  kv("settlement fee", `${fmt(p1.feeAmount)}  (0.50% of the escrowed portion, only on success)`);
  kv("merchant has", fmt((await getAccount(provider.connection, merchantToken)).amount));
  kv("buyer balance", fmt((await getAccount(provider.connection, buyerToken)).amount));
  kv("tx", explorer("tx", sig, rpcUrl));

  step(5, "close_payment — reclaim the order record's rent");
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
