/**
 * Agent CTOS x402 escrow — live demo of the collateral-routed model.
 *
 * Five acts, each stating a claim and proving it with a real transaction.
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
  createMint as rawCreateMint,
  createAccount as rawCreateAccount,
  mintTo as rawMintTo,
  getAccount as rawGetAccount,
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

/** Act 5 starts this clock; the same act waits it out. */
const RUG_TIMEOUT_SECONDS = 60;

function act(n: number, title: string) {
  console.log(`\n── ACT ${n} · ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
}
const claim = (t: string) => console.log(`   CLAIM   ${t}`);
const proof = (t: string) => console.log(`   PROOF   ${t}`);
const note = (t: string) => console.log(`           ${t}`);

/**
 * Every RPC failure this demo has ever hit in practice — a blockhash the
 * receiving node hasn't seen yet (load-balanced providers route the fetch
 * and the send to different backends), rate limits, socket timeouts. All of
 * them are transient and clear on a retry, because a retry fetches a fresh
 * blockhash. A real program error is NOT in this list and is rethrown at
 * once, so genuine bugs still fail loudly instead of being retried away.
 */
const TRANSIENT =
  /blockhash not found|block height exceeded|blockhash expired|429|too many requests|timed out|timeout|socket hang up|fetch failed|econnreset|node is behind|failed to get/i;

/**
 * web3.js caches the blockhash for 30s and `connection.sendTransaction` — the
 * path the spl-token helpers take — reads that cache. The whole backoff
 * schedule below fits inside 30s, so without this a retry would replay the
 * exact blockhash that just failed, six times over. Dropping the cache forces
 * the next attempt to fetch a genuinely new one.
 */
function freshenBlockhash(conn: any) {
  if (conn && conn._blockhashInfo) {
    conn._blockhashInfo = {
      latestBlockhash: null,
      lastFetch: 0,
      transactionSignatures: [],
      simulatedSignatures: [],
    };
  }
}

async function rpc<T>(
  label: string,
  fn: () => Promise<T>,
  conn?: any,
  attempts = 6
): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = `${e?.message ?? e} ${e?.transactionMessage ?? ""}`;
      if (!TRANSIENT.test(msg) || i === attempts) throw e;
      const backoff = Math.min(500 * 2 ** (i - 1), 8_000);
      console.log(`           (${label}: transient RPC error, retrying in ${backoff}ms)`);
      freshenBlockhash(conn);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/** A breath between sends. Firing ~20 transactions flat out is what earns a 429. */
const pace = () => new Promise((r) => setTimeout(r, 300));

// The spl-token helpers send their own transactions through their own
// sendAndConfirmTransaction, so the provider-level wrapper below never sees
// them. Re-export them under their original names with retry (and, for the
// three that send, pacing) folded in, so every call site downstream is
// covered without having to say so.
// args[0] is always the Connection, which `rpc` needs so it can drop the stale
// blockhash between attempts.
const createMint: typeof rawCreateMint = async (...args) => {
  const r = await rpc("createMint", () => rawCreateMint(...args), args[0]);
  await pace();
  return r;
};
const createAccount: typeof rawCreateAccount = async (...args) => {
  const r = await rpc("createAccount", () => rawCreateAccount(...args), args[0]);
  await pace();
  return r;
};
const mintTo: typeof rawMintTo = async (...args) => {
  const r = await rpc("mintTo", () => rawMintTo(...args), args[0]);
  await pace();
  return r;
};
// getAccount needs no wrapper of its own: it reads through
// connection.getAccountInfo, which is wrapped at the connection level below.
// Nesting a second retry around it would only stack backoffs.
const getAccount = rawGetAccount;

function explorer(kind: "tx" | "address", id: string, rpcUrl: string): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (rpcUrl.includes("devnet")) return `${base}?cluster=devnet`;
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  }
  return base;
}

async function main() {
  const env = anchor.AnchorProvider.env();
  const connection = new anchor.web3.Connection(env.connection.rpcEndpoint, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 90_000,
  });
  const provider = new anchor.AnchorProvider(connection, env.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  // Every Anchor `.rpc()` in this file funnels through provider.sendAndConfirm,
  // and every `program.account.*.fetch` through connection.getAccountInfo.
  // Wrapping the two chokepoints covers all of them at once. Retrying a send is
  // safe here because Anchor re-fetches the blockhash and re-signs on each
  // attempt — which is precisely the cure for "Blockhash not found".
  const sendAndConfirm = provider.sendAndConfirm.bind(provider);
  (provider as any).sendAndConfirm = async (tx: any, signers?: any, opts?: any) => {
    const sig = await rpc("tx", () => sendAndConfirm(tx, signers, opts), connection);
    await pace();
    return sig;
  };
  const getAccountInfo = connection.getAccountInfo.bind(connection);
  (connection as any).getAccountInfo = (pubkey: any, cfg?: any) =>
    rpc("getAccountInfo", () => getAccountInfo(pubkey, cfg), connection);

  anchor.setProvider(provider);

  const program = loadProgram(provider);
  const rpcUrl = provider.connection.rpcEndpoint;
  // `payer` is the user's own persistent, funded wallet — used only to fund
  // and mint for everyone else. `buyer` is a fresh identity every run, same
  // as the merchants below: BuyerStanding is keyed only by buyer pubkey, so
  // reusing a persistent wallet there would make register_buyer collide on
  // a second run, and would make Act 2's "zero orders settled" claim false
  // the moment it wasn't actually a first run.
  const payer = (provider.wallet as anchor.Wallet).payer;
  const buyer = Keypair.generate();
  // Retry and pacing come from the wrapped provider.sendAndConfirm above.
  const fundSol = async (dest: PublicKey, lamports: number) => {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports })
    );
    await provider.sendAndConfirm(tx);
  };
  await fundSol(buyer.publicKey, 100_000_000);

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
    PublicKey.findProgramAddressSync([Buffer.from("vault"), payment.toBuffer()], program.programId)[0];
  const reservePda = (merchant: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("reserve"), merchant.toBuffer()], program.programId)[0];
  const reserveVaultPda = (reserve: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("reserve_vault"), reserve.toBuffer()], program.programId)[0];
  const standingPda = (b: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("standing"), b.toBuffer()], program.programId)[0];

  console.log("=".repeat(72));
  console.log(" AGENT CTOS — x402 ESCROW, ROUTED BY COLLATERAL");
  console.log(" Extraction is bounded by posted collateral, not by knowing who anyone is.");
  console.log("=".repeat(72));
  console.log(` Network   ${rpcUrl}`);
  console.log(` Program   ${program.programId.toBase58()}`);
  console.log(` Buyer     ${buyer.publicKey.toBase58()}`);

  const mint = await createMint(provider.connection, payer, provider.wallet.publicKey, null, DECIMALS);
  const buyerToken = await createAccount(provider.connection, payer, mint, buyer.publicKey, Keypair.generate());
  await mintTo(provider.connection, payer, mint, buyerToken, provider.wallet.publicKey, BigInt(unit(1_000).toString()));
  console.log(` Token     ${mint.toBase58()} (6 decimals, 1,000 minted to buyer)`);

  const treasuryToken = await createAccount(provider.connection, payer, mint, TREASURY, Keypair.generate());

  const honest = Keypair.generate();
  const rugger = Keypair.generate();
  // open_reserve/post_reserve have the merchant pay its own PDA rent, unlike
  // everything else in this demo where the persistent wallet covers fees —
  // fund both generated merchants with real lamports before either signs.
  await fundSol(honest.publicKey, 20_000_000);
  await fundSol(rugger.publicKey, 20_000_000);
  const honestToken = await createAccount(provider.connection, payer, mint, honest.publicKey, Keypair.generate());
  const ruggerToken = await createAccount(provider.connection, payer, mint, rugger.publicKey, Keypair.generate());

  const payFor = async (merchant: PublicKey, merchantToken: PublicKey, amount: BN, orderId: BN, timeout: number) => {
    const payment = paymentPda(merchant, orderId);
    const reserve = reservePda(merchant);
    const sig = await program.methods
      .initiatePayment(amount, orderId, new BN(timeout))
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        buyerToken,
        merchantToken,
        escrowVault: vaultPda(payment),
        merchantReserve: reserve,
        reserveVault: reserveVaultPda(reserve),
        buyerStanding: standingPda(buyer.publicKey),
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
  act(1, "A merchant posts collateral; the buyer sets up a history");
  claim("Instant payment is never a matter of trust — it is capped by real, posted collateral.");

  const reserve = reservePda(honest.publicKey);
  const reserveVault = reserveVaultPda(reserve);
  const openSig = await program.methods
    .openReserve()
    .accounts({
      reserve,
      merchant: honest.publicKey,
      reserveVault,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([honest])
    .rpc();
  record("open_reserve(honest)", openSig);

  const merchantFunding = await createAccount(provider.connection, payer, mint, honest.publicKey, Keypair.generate());
  await mintTo(provider.connection, payer, mint, merchantFunding, provider.wallet.publicKey, BigInt(unit(100).toString()));
  const postSig = await program.methods
    .postReserve(unit(100))
    .accounts({
      reserve,
      merchant: honest.publicKey,
      reserveVault,
      merchantToken: merchantFunding,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([honest])
    .rpc();
  record("post_reserve(honest, 100)", postSig);

  const registerSig = await program.methods
    .registerBuyer()
    .accounts({ standing: standingPda(buyer.publicKey), buyer: buyer.publicKey, systemProgram: SystemProgram.programId })
    .signers([buyer])
    .rpc();
  record("register_buyer", registerSig);
  proof(`merchant reserve holds ${fmt((await getAccount(provider.connection, reserveVault)).amount)} tokens`);
  note("The buyer has just registered, with zero orders settled — standing is not the same as intent.");

  // -------------------------------------------------------------------
  act(2, "This buyer's first order is still fully escrowed");
  claim("A brand-new buyer defaults to protection, even against a fully-collateralized merchant.");

  const orderA = new BN(Date.now() % 100_000);
  const a = await payFor(honest.publicKey, honestToken, unit(30), orderA, 3600);
  record("initiate_payment(honest, first order)", a.sig);

  const pa: any = await program.account.payment.fetch(a.payment);
  proof(
    `instant ${fmt(pa.instantAmount)}, escrowed ${fmt(pa.escrowedAmount)} — ` +
      `full escrow despite ${fmt(unit(100))} in reserve, because standing is still zero`
  );

  const sigConfirmA = await program.methods
    .confirmDelivery(orderA)
    .accounts({
      payment: a.payment,
      buyer: buyer.publicKey,
      escrowVault: a.vault,
      merchantToken: honestToken,
      treasuryToken,
      merchantReserve: reserve,
      buyerStanding: standingPda(buyer.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([buyer])
    .rpc();
  record("confirm_delivery(honest, first order)", sigConfirmA);
  const standingNow: any = await program.account.buyerStanding.fetch(standingPda(buyer.publicKey));
  note(`Delivery confirmed. settled_count is now ${standingNow.settledCount} — the buyer just earned standing.`);

  // -------------------------------------------------------------------
  act(3, "The same buyer's next order pays the merchant instantly");
  claim("Established standing plus real collateral is what the router actually rewards.");

  const orderA2 = orderA.add(new BN(1));
  const a2 = await payFor(honest.publicKey, honestToken, unit(60), orderA2, 3600);
  record("initiate_payment(honest, second order)", a2.sig);

  const pa2: any = await program.account.payment.fetch(a2.payment);
  proof(
    `instant ${fmt(pa2.instantAmount)}, escrowed ${fmt(pa2.escrowedAmount)} — ` +
      `paid in full, immediately, no fee on the instant portion`
  );
  note(`Merchant balance is now ${fmt((await getAccount(provider.connection, honestToken)).amount)}, before any confirmation at all.`);

  const sigCloseA = await program.methods
    .closePayment(orderA)
    .accounts({ payment: a.payment, buyer: buyer.publicKey })
    .signers([buyer])
    .rpc();
  record("close_payment(honest, first order)", sigCloseA);

  // -------------------------------------------------------------------
  act(4, "A second merchant posts collateral, takes an instant order, and vanishes");
  claim("The rug starts here — and this time there is something to lose besides the escrow.");

  const ruggerReserve = reservePda(rugger.publicKey);
  const ruggerReserveVault = reserveVaultPda(ruggerReserve);
  await program.methods
    .openReserve()
    .accounts({
      reserve: ruggerReserve,
      merchant: rugger.publicKey,
      reserveVault: ruggerReserveVault,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([rugger])
    .rpc();
  const ruggerFunding = await createAccount(provider.connection, payer, mint, rugger.publicKey, Keypair.generate());
  await mintTo(provider.connection, payer, mint, ruggerFunding, provider.wallet.publicKey, BigInt(unit(40).toString()));
  await program.methods
    .postReserve(unit(40))
    .accounts({
      reserve: ruggerReserve,
      merchant: rugger.publicKey,
      reserveVault: ruggerReserveVault,
      merchantToken: ruggerFunding,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([rugger])
    .rpc();

  const orderB = orderA2.add(new BN(1));
  const b = await payFor(rugger.publicKey, ruggerToken, unit(40), orderB, RUG_TIMEOUT_SECONDS);
  record("initiate_payment(rugger)", b.sig);
  const pb: any = await program.account.payment.fetch(b.payment);
  proof(
    `instant ${fmt(pb.instantAmount)} paid to the rugger already, backed by its own ${fmt(unit(40))}-token reserve`
  );
  note(`Reclaimable after ${new Date(pb.expiry.toNumber() * 1000).toISOString()}. The merchant did not deliver, and never will.`);

  // -------------------------------------------------------------------
  act(5, "Surviving the rug: the reserve gets skimmed, the buyer is made whole");
  claim("Timeout does not just return the escrow — it recovers the instant portion from collateral too.");

  const waitMs = Math.max(0, pb.expiry.toNumber() * 1000 - Date.now()) + 2_000;
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
      merchantReserve: ruggerReserve,
      reserveVault: ruggerReserveVault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([buyer])
    .rpc();
  record("reclaim_timeout(rugger)", sigReclaim);

  const afterBuyer = (await getAccount(provider.connection, buyerToken)).amount;
  const ruggerReserveAfter: any = await program.account.merchantReserve.fetch(ruggerReserve);
  proof(
    `buyer recovered ${fmt(Number(afterBuyer - beforeBuyer))} in total — the full order, ` +
      `instant portion included, straight out of the rugger's own reserve`
  );
  note(`Rugger's reserve balance: ${fmt((await getAccount(provider.connection, ruggerReserveVault)).amount)}; locked exposure: ${fmt(ruggerReserveAfter.lockedExposure)}.`);
  note("No merchant signature anywhere in that transaction. Fake reputation could not have prevented this,");
  note("and did not need to be detected — the loss was already bounded by what the rugger itself posted.");

  // -------------------------------------------------------------------
  console.log("\n" + "=".repeat(72));
  console.log(" VERIFY INDEPENDENTLY");
  console.log("=".repeat(72));
  console.log(links.join("\n"));
  console.log(`\n   Buyer final balance   ${fmt((await getAccount(provider.connection, buyerToken)).amount)}`);
  console.log("   Every figure above was read back from on-chain state.\n");
}

main().catch((e) => {
  console.error("\nDemo failed:", e);
  process.exit(1);
});
