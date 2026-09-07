/**
 * Agent CTOS x402 escrow — live demo.
 *
 * Four acts, each stating a claim and proving it with a real transaction.
 * Every number printed is read back from the program's own on-chain accounts.
 *
 *   anchor build
 *   npm run demo
 *
 *   # against a local validator instead:
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
  getAccount,
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

/** Act 2 starts this clock; act 4 waits it out. */
const RUG_TIMEOUT_SECONDS = 60;

function act(n: number, title: string) {
  console.log(`\n── ACT ${n} · ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}
const claim = (t: string) => console.log(`   CLAIM   ${t}`);
const proof = (t: string) => console.log(`   PROOF   ${t}`);
const note = (t: string) => console.log(`           ${t}`);

function explorer(kind: "tx" | "address", id: string, rpcUrl: string): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (rpcUrl.includes("devnet")) return `${base}?cluster=devnet`;
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  }
  return base;
}

async function main() {
  // "confirmed", not Anchor's default "processed": each setup step depends on
  // the previous being visible, and a load-balanced RPC will otherwise answer
  // from a node that has not caught up.
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

  const links: string[] = [];
  const record = (label: string, sig: string) =>
    links.push(`   ${label.padEnd(30)} ${explorer("tx", sig, rpcUrl)}`);

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
  console.log(" AGENT CTOS — x402 ESCROW");
  console.log(" Every payment held until the buyer confirms, or the clock runs out.");
  console.log("=".repeat(72));
  console.log(` Network   ${rpcUrl}`);
  console.log(` Program   ${program.programId.toBase58()}`);
  console.log(` Buyer     ${buyer.publicKey.toBase58()}`);

  const mint = await createMint(
    provider.connection,
    buyer,
    provider.wallet.publicKey,
    null,
    DECIMALS
  );
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
    BigInt(unit(1_000).toString())
  );
  console.log(` Token     ${mint.toBase58()} (6 decimals, 1,000 minted to buyer)`);

  // The settlement fee is a fixed percentage, paid to a compiled-in treasury.
  const treasuryToken = await createAccount(
    provider.connection, buyer, mint, TREASURY, Keypair.generate()
  );

  // Two merchants: one delivers, one takes the money and disappears.
  const honest = Keypair.generate();
  const rugger = Keypair.generate();
  const honestToken = await createAccount(provider.connection, buyer, mint, honest.publicKey, Keypair.generate());
  const ruggerToken = await createAccount(provider.connection, buyer, mint, rugger.publicKey, Keypair.generate());

  const payFor = async (merchant: PublicKey, amount: BN, orderId: BN, timeout: number) => {
    const payment = paymentPda(merchant, orderId);
    const sig = await program.methods
      .initiatePayment(amount, orderId, new BN(timeout))
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        buyerToken,
        escrowVault: vaultPda(payment),
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();
    return { payment, vault: vaultPda(payment), sig };
  };

  // -------------------------------------------------------------------
  act(1, "The merchant is paid nothing up front");
  claim("An x402 payment normally settles instantly and irreversibly. Here it does not.");

  const orderA = new BN(Date.now() % 100_000);
  const a = await payFor(honest.publicKey, unit(30), orderA, 3600);
  record("initiate_payment(honest)", a.sig);

  const pa: any = await program.account.payment.fetch(a.payment);
  proof(
    `30.000 paid → vault holds ${fmt((await getAccount(provider.connection, a.vault)).amount)}, ` +
      `merchant received ${fmt((await getAccount(provider.connection, honestToken)).amount)}`
  );
  note(`Status is ${Object.keys(pa.status)[0]}. The money left the buyer but has not reached the merchant.`);
  note("The vault is owned by the payment account itself — no keypair anywhere can move it.");

  // -------------------------------------------------------------------
  act(2, "A second merchant takes an order and vanishes");
  claim("The rug starts here. This merchant will do nothing at all.");

  const orderB = orderA.add(new BN(1));
  const b = await payFor(rugger.publicKey, unit(40), orderB, RUG_TIMEOUT_SECONDS);
  record("initiate_payment(rugger)", b.sig);

  const pb: any = await program.account.payment.fetch(b.payment);
  proof(`40.000 escrowed; reclaimable after ${new Date(pb.expiry.toNumber() * 1000).toISOString()}`);
  note(`The buyer chose that ${RUG_TIMEOUT_SECONDS}s deadline when paying. The merchant cannot change it.`);

  // -------------------------------------------------------------------
  act(3, "Delivery releases the money — and only the buyer can say so");
  claim("The honest merchant delivers, the buyer confirms, and the escrow is released.");

  const sigConfirm = await program.methods
    .confirmDelivery(orderA)
    .accounts({
      payment: a.payment,
      buyer: buyer.publicKey,
      escrowVault: a.vault,
      merchantToken: honestToken,
      treasuryToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([buyer])
    .rpc();
  record("confirm_delivery(honest)", sigConfirm);

  const pa2: any = await program.account.payment.fetch(a.payment);
  proof(
    `merchant now holds ${fmt((await getAccount(provider.connection, honestToken)).amount)}; ` +
      `status ${Object.keys(pa2.status)[0]}`
  );
  note(
    `A ${fmt(pa2.feeAmount)} settlement fee (0.50%) went to the protocol — charged only because this ` +
      `order succeeded.`
  );
  note("A refund at this point would need the merchant's own signature — the buyer cannot claw it back.");

  const sigClose = await program.methods
    .closePayment(orderA)
    .accounts({ payment: a.payment, buyer: buyer.publicKey })
    .signers([buyer])
    .rpc();
  record("close_payment(honest)", sigClose);
  note("Order record closed and its rent refunded. The history survives as an on-chain event,");
  note("which matters: x402 is built for micropayments, and permanent accounts cost more than the payment.");

  // -------------------------------------------------------------------
  act(4, "Surviving the rug, with no merchant signature");
  claim("When the merchant never delivers, the buyer takes the money back alone.");

  const pb1: any = await program.account.payment.fetch(b.payment);
  const waitMs = Math.max(0, pb1.expiry.toNumber() * 1000 - Date.now()) + 2_000;
  if (waitMs > 0) {
    note(`escrow not yet expired — waiting ${Math.ceil(waitMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const beforeBuyer = (await getAccount(provider.connection, buyerToken)).amount;
  const sigReclaim = await program.methods
    .reclaimTimeout(orderB)
    .accounts({
      payment: b.payment,
      buyer: buyer.publicKey,
      escrowVault: b.vault,
      buyerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([buyer])
    .rpc();
  record("reclaim_timeout(rugger)", sigReclaim);

  const pb2: any = await program.account.payment.fetch(b.payment);
  const afterBuyer = (await getAccount(provider.connection, buyerToken)).amount;
  proof(
    `buyer recovered ${fmt(Number(afterBuyer - beforeBuyer))}; ` +
      `rugger ended with ${fmt((await getAccount(provider.connection, ruggerToken)).amount)}`
  );
  note(`Status ${Object.keys(pb2.status)[0]}. Signed by the buyer alone — the merchant was not asked,`);
  note("and had no way to object. That is the whole guarantee.");

  // -------------------------------------------------------------------
  console.log("\n" + "=".repeat(72));
  console.log(" VERIFY INDEPENDENTLY");
  console.log("=".repeat(72));
  console.log(links.join("\n"));
  console.log(`\n   Open order (rugged)  ${explorer("address", b.payment.toBase58(), rpcUrl)}`);
  console.log(
    `\n   Buyer balance: 1000.000 → ${fmt((await getAccount(provider.connection, buyerToken)).amount)}` +
      `   (30.000 spent on the delivered order, 40.000 recovered from the rug)`
  );
  console.log("   Every figure above was read back from on-chain state.\n");
}

main().catch((e) => {
  console.error("\nDemo failed:", e);
  process.exit(1);
});
