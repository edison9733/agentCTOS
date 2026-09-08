/**
 * Server-driven live demo — one act per request.
 *
 * The five acts of scripts/demo.ts, exposed as a serverless endpoint so a
 * browser can run them against real devnet without the visitor needing a
 * wallet, devnet SOL, or the demo token.
 *
 * WHY ONE ACT PER REQUEST, rather than one call that runs the whole demo:
 * act 4 opens an escrow that cannot be reclaimed until it expires 60s later.
 * Running the demo end to end therefore takes ~90s, most of it spent asleep —
 * well past a serverless function's budget. Splitting it lets each request
 * finish in seconds and puts the wait in the browser, where a countdown is
 * better theatre than a blocked socket anyway.
 *
 * STATE. Serverless invocations share nothing, so the run's state travels to
 * the client and back in an opaque `session` blob. It carries the secret keys
 * of the throwaway buyer and merchant keypairs this run generated. That is
 * deliberate and safe *only* because those keys are created per run, hold
 * nothing but devnet play money, and are abandoned when the run ends. The
 * server wallet's key never leaves the server.
 *
 * Set DEMO_WALLET_SECRET to a funded devnet keypair (base58 secret key, or the
 * JSON array from a Solana CLI keypair file). Optionally set DEMO_RPC_URL.
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Connection } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint as rawCreateMint,
  createAccount as rawCreateAccount,
  mintTo as rawMintTo,
  getAccount,
} from "@solana/spl-token";
import bs58 from "bs58";

// The IDL has to be a committed file: target/ is gitignored, so the build
// output does not exist on the deployment. `npm run sync-idl` copies it here.
import idl from "../idl/x402_scoring.json";

type Req = { method?: string; body?: any };
type Res = {
  status: (code: number) => Res;
  json: (body: any) => void;
  setHeader: (k: string, v: string) => void;
};

const DECIMALS = 6;
const RUG_TIMEOUT_SECONDS = 60;
const TREASURY = new PublicKey("5i7zzV9hQUCbpg8MXSNJB3QQkL6zscDd8VQKow46vg7E");

/** Below this the run would fail partway through and strand the visitor. */
const MIN_WALLET_LAMPORTS = 120_000_000;

const unit = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));
const fmt = (n: BN | bigint | number) => {
  const v = typeof n === "bigint" ? Number(n) : typeof n === "number" ? n : n.toNumber();
  return (v / 10 ** DECIMALS).toFixed(3);
};

/* ------------------------------------------------------------------ *
 * Transient RPC handling — identical policy to scripts/demo.ts: retry
 * the known-transient classes, rethrow a real program error at once.
 * ------------------------------------------------------------------ */

const TRANSIENT =
  /blockhash not found|block height exceeded|blockhash expired|429|too many requests|timed out|timeout|socket hang up|fetch failed|econnreset|node is behind|failed to get/i;

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

async function rpc<T>(label: string, fn: () => Promise<T>, conn?: any, attempts = 5): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = `${e?.message ?? e} ${e?.transactionMessage ?? ""}`;
      if (!TRANSIENT.test(msg) || i === attempts) throw e;
      // stderr only — this is a server log, never part of the JSON response.
      console.error(`[x402] ${label}: transient RPC error, retry ${i}`);
      freshenBlockhash(conn);
      await new Promise((r) => setTimeout(r, Math.min(400 * 2 ** (i - 1), 4_000)));
    }
  }
  throw lastErr;
}

const pace = () => new Promise((r) => setTimeout(r, 250));

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

/* ------------------------------------------------------------------ *
 * Session — the run's state, round-tripped through the client.
 * ------------------------------------------------------------------ */

type Session = {
  mint: string;
  buyer: string; // base58 secret key, throwaway
  honest: string;
  rugger: string;
  buyerToken: string;
  honestToken: string;
  ruggerToken: string;
  treasuryToken: string;
  orderA?: string;
  orderA2?: string;
  orderB?: string;
  expiry?: number;
  beforeReclaim?: string;
};

const encodeSession = (s: Session) => Buffer.from(JSON.stringify(s), "utf8").toString("base64");
const decodeSession = (s: string): Session => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const kp = (secret: string) => Keypair.fromSecretKey(bs58.decode(secret));

function serverWallet(): Keypair {
  const raw = process.env.DEMO_WALLET_SECRET;
  if (!raw) {
    throw new Error(
      "DEMO_WALLET_SECRET is not set. Point it at a funded devnet keypair — " +
        "either the base58 secret key or the JSON array from ~/.config/solana/id.json."
    );
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

function build() {
  const wallet = serverWallet();
  const url = process.env.DEMO_RPC_URL || "https://api.devnet.solana.com";
  // "confirmed", not Anchor's default "processed": a load-balanced RPC would
  // otherwise answer a read from a node that has not seen the write yet.
  const connection = new Connection(url, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  const sendAndConfirm = provider.sendAndConfirm.bind(provider);
  (provider as any).sendAndConfirm = async (tx: any, signers?: any, opts?: any) => {
    const sig = await rpc("tx", () => sendAndConfirm(tx, signers, opts), connection);
    await pace();
    return sig;
  };
  const getAccountInfo = connection.getAccountInfo.bind(connection);
  (connection as any).getAccountInfo = (pubkey: any, cfg?: any) =>
    rpc("getAccountInfo", () => getAccountInfo(pubkey, cfg), connection);

  // Anchor 0.29 only stamps metadata.address into the IDL on deploy, so the
  // build output usually lacks it. Prefer the explicit env var.
  const address = process.env.DEMO_PROGRAM_ID || (idl as any).metadata?.address;
  if (!address) {
    throw new Error(
      "No program id. Set DEMO_PROGRAM_ID to the deployed address " +
        "(HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4 on devnet)."
    );
  }
  const programId = new PublicKey(address);
  const program = new anchor.Program(idl as any, programId, provider) as Program<any>;
  return { wallet, connection, provider, program };
}

/* ------------------------------------------------------------------ *
 * PDAs — same seeds as the program.
 * ------------------------------------------------------------------ */

const pda = (seeds: (Buffer | Uint8Array)[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

const paymentPda = (buyer: PublicKey, merchant: PublicKey, orderId: BN, pid: PublicKey) =>
  pda(
    [Buffer.from("payment"), buyer.toBuffer(), merchant.toBuffer(), orderId.toArrayLike(Buffer, "le", 8)],
    pid
  );
const vaultPda = (payment: PublicKey, pid: PublicKey) => pda([Buffer.from("vault"), payment.toBuffer()], pid);
const reservePda = (merchant: PublicKey, pid: PublicKey) => pda([Buffer.from("reserve"), merchant.toBuffer()], pid);
const reserveVaultPda = (reserve: PublicKey, pid: PublicKey) =>
  pda([Buffer.from("reserve_vault"), reserve.toBuffer()], pid);
const standingPda = (buyer: PublicKey, pid: PublicKey) => pda([Buffer.from("standing"), buyer.toBuffer()], pid);

/* ------------------------------------------------------------------ *
 * The acts.
 * ------------------------------------------------------------------ */

type Line = { kind: "proof" | "note"; text: string };
type Link = { label: string; sig: string };
type ActResult = {
  act: number;
  title: string;
  claim: string;
  lines: Line[];
  links: Link[];
  session: Session;
  /** Unix ms the escrow becomes reclaimable; the client counts this down. */
  waitUntil?: number;
  done?: boolean;
};

async function runAct(actNo: number, session: Session | null): Promise<ActResult> {
  const { wallet, connection, provider, program } = build();
  const pid = program.programId;

  const fundSol = async (dest: PublicKey, lamports: number) => {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: dest, lamports })
    );
    await provider.sendAndConfirm(tx);
  };

  /* ---- Act 0: build the world ------------------------------------ */
  if (actNo === 0) {
    const balance = await connection.getBalance(wallet.publicKey);
    if (balance < MIN_WALLET_LAMPORTS) {
      throw new Error(
        `The demo wallet is low on devnet SOL (${(balance / 1e9).toFixed(3)} SOL). ` +
          `A full run needs about ${(MIN_WALLET_LAMPORTS / 1e9).toFixed(2)} SOL. Top it up and try again.`
      );
    }

    const buyer = Keypair.generate();
    const honest = Keypair.generate();
    const rugger = Keypair.generate();

    const mint = await createMint(connection, wallet, wallet.publicKey, null, DECIMALS);
    const buyerToken = await createAccount(connection, wallet, mint, buyer.publicKey, Keypair.generate());
    await mintTo(connection, wallet, mint, buyerToken, wallet.publicKey, BigInt(unit(1_000).toString()));
    const treasuryToken = await createAccount(connection, wallet, mint, TREASURY, Keypair.generate());

    // open_reserve/post_reserve have the merchant pay its own PDA rent, so
    // both generated merchants need real lamports before either can sign.
    await fundSol(buyer.publicKey, 40_000_000);
    await fundSol(honest.publicKey, 20_000_000);
    await fundSol(rugger.publicKey, 20_000_000);

    const honestToken = await createAccount(connection, wallet, mint, honest.publicKey, Keypair.generate());
    const ruggerToken = await createAccount(connection, wallet, mint, rugger.publicKey, Keypair.generate());

    const s: Session = {
      mint: mint.toBase58(),
      buyer: bs58.encode(buyer.secretKey),
      honest: bs58.encode(honest.secretKey),
      rugger: bs58.encode(rugger.secretKey),
      buyerToken: buyerToken.toBase58(),
      honestToken: honestToken.toBase58(),
      ruggerToken: ruggerToken.toBase58(),
      treasuryToken: treasuryToken.toBase58(),
    };

    return {
      act: 0,
      title: "A fresh world, built on devnet",
      claim: "Every run starts from nothing — new token, new buyer, new merchants.",
      lines: [
        { kind: "proof", text: `token ${mint.toBase58()} · 6 decimals · 1,000 minted to the buyer` },
        { kind: "note", text: "The buyer is generated per run, so its standing genuinely starts at zero." },
      ],
      links: [],
      session: s,
    };
  }

  if (!session) throw new Error("Missing session — start the demo from the beginning.");
  const s: Session = { ...session };
  const buyer = kp(s.buyer);
  const honest = kp(s.honest);
  const rugger = kp(s.rugger);
  const mint = new PublicKey(s.mint);
  const buyerToken = new PublicKey(s.buyerToken);
  const honestToken = new PublicKey(s.honestToken);
  const ruggerToken = new PublicKey(s.ruggerToken);
  const treasuryToken = new PublicKey(s.treasuryToken);

  const payFor = async (merchant: PublicKey, merchantToken: PublicKey, amount: BN, orderId: BN, timeout: number) => {
    const payment = paymentPda(buyer.publicKey, merchant, orderId, pid);
    const reserve = reservePda(merchant, pid);
    const sig = await program.methods
      .initiatePayment(amount, orderId, new BN(timeout))
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        buyerToken,
        merchantToken,
        escrowVault: vaultPda(payment, pid),
        merchantReserve: reserve,
        reserveVault: reserveVaultPda(reserve, pid),
        buyerStanding: standingPda(buyer.publicKey, pid),
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();
    return { payment, vault: vaultPda(payment, pid), sig };
  };

  const openAndPost = async (merchant: Keypair, amount: BN) => {
    const reserve = reservePda(merchant.publicKey, pid);
    const reserveVault = reserveVaultPda(reserve, pid);
    const openSig = await program.methods
      .openReserve()
      .accounts({
        reserve,
        merchant: merchant.publicKey,
        reserveVault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([merchant])
      .rpc();

    const funding = await createAccount(connection, wallet, mint, merchant.publicKey, Keypair.generate());
    await mintTo(connection, wallet, mint, funding, wallet.publicKey, BigInt(amount.toString()));
    const postSig = await program.methods
      .postReserve(amount)
      .accounts({ reserve, merchant: merchant.publicKey, reserveVault, merchantToken: funding, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([merchant])
      .rpc();

    return { reserve, reserveVault, openSig, postSig };
  };

  /* ---- Act 1 ------------------------------------------------------ */
  if (actNo === 1) {
    const { reserveVault, openSig, postSig } = await openAndPost(honest, unit(100));
    const registerSig = await program.methods
      .registerBuyer()
      .accounts({ standing: standingPda(buyer.publicKey, pid), buyer: buyer.publicKey, systemProgram: SystemProgram.programId })
      .signers([buyer])
      .rpc();

    const held = (await getAccount(connection, reserveVault)).amount;
    return {
      act: 1,
      title: "A merchant posts collateral; the buyer sets up a history",
      claim: "Instant payment is never a matter of trust — it is capped by real, posted collateral.",
      lines: [
        { kind: "proof", text: `merchant reserve holds ${fmt(held)} tokens` },
        { kind: "note", text: "The buyer has just registered, with zero orders settled — standing is not the same as intent." },
      ],
      links: [
        { label: "open_reserve(honest)", sig: openSig },
        { label: "post_reserve(honest, 100)", sig: postSig },
        { label: "register_buyer", sig: registerSig },
      ],
      session: s,
    };
  }

  /* ---- Act 2 ------------------------------------------------------ */
  if (actNo === 2) {
    const orderA = new BN(Date.now() % 100_000);
    const a = await payFor(honest.publicKey, honestToken, unit(30), orderA, 3600);
    const pa: any = await program.account.payment.fetch(a.payment);

    const confirmSig = await program.methods
      .confirmDelivery(orderA)
      .accounts({
        payment: a.payment,
        buyer: buyer.publicKey,
        escrowVault: a.vault,
        merchantToken: honestToken,
        treasuryToken,
        merchantReserve: reservePda(honest.publicKey, pid),
        buyerStanding: standingPda(buyer.publicKey, pid),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const standing: any = await program.account.buyerStanding.fetch(standingPda(buyer.publicKey, pid));
    s.orderA = orderA.toString();

    return {
      act: 2,
      title: "This buyer's first order is still fully escrowed",
      claim: "A brand-new buyer defaults to protection, even against a fully-collateralized merchant.",
      lines: [
        {
          kind: "proof",
          text: `instant ${fmt(pa.instantAmount)}, escrowed ${fmt(pa.escrowedAmount)} — full escrow despite 100.000 in reserve, because standing is still zero`,
        },
        { kind: "note", text: `Delivery confirmed. settled_count is now ${standing.settledCount} — the buyer just earned standing.` },
      ],
      links: [
        { label: "initiate_payment(honest, first order)", sig: a.sig },
        { label: "confirm_delivery(honest, first order)", sig: confirmSig },
      ],
      session: s,
    };
  }

  /* ---- Act 3 ------------------------------------------------------ */
  if (actNo === 3) {
    const orderA = new BN(s.orderA!);
    const orderA2 = orderA.add(new BN(1));
    const a2 = await payFor(honest.publicKey, honestToken, unit(60), orderA2, 3600);
    const pa2: any = await program.account.payment.fetch(a2.payment);
    const merchantBalance = (await getAccount(connection, honestToken)).amount;

    const closeSig = await program.methods
      .closePayment(orderA)
      .accounts({ payment: paymentPda(buyer.publicKey, honest.publicKey, orderA, pid), buyer: buyer.publicKey })
      .signers([buyer])
      .rpc();

    s.orderA2 = orderA2.toString();
    return {
      act: 3,
      title: "The same buyer's next order pays the merchant instantly",
      claim: "Established standing plus real collateral is what the router actually rewards.",
      lines: [
        {
          kind: "proof",
          text: `instant ${fmt(pa2.instantAmount)}, escrowed ${fmt(pa2.escrowedAmount)} — paid in full, immediately, no fee on the instant portion`,
        },
        { kind: "note", text: `Merchant balance is now ${fmt(merchantBalance)}, before any confirmation at all.` },
      ],
      links: [
        { label: "initiate_payment(honest, second order)", sig: a2.sig },
        { label: "close_payment(honest, first order)", sig: closeSig },
      ],
      session: s,
    };
  }

  /* ---- Act 4 ------------------------------------------------------ */
  if (actNo === 4) {
    const { openSig, postSig } = await openAndPost(rugger, unit(40));
    const orderB = new BN(s.orderA2!).add(new BN(1));
    const b = await payFor(rugger.publicKey, ruggerToken, unit(40), orderB, RUG_TIMEOUT_SECONDS);
    const pb: any = await program.account.payment.fetch(b.payment);

    s.orderB = orderB.toString();
    s.expiry = pb.expiry.toNumber() * 1000;
    s.beforeReclaim = (await getAccount(connection, buyerToken)).amount.toString();

    return {
      act: 4,
      title: "A second merchant posts collateral, takes an instant order, and vanishes",
      claim: "The rug starts here — and this time there is something to lose besides the escrow.",
      lines: [
        { kind: "proof", text: `instant ${fmt(pb.instantAmount)} paid to the rugger already, backed by its own 40.000-token reserve` },
        { kind: "note", text: "The merchant did not deliver, and never will. The escrow becomes reclaimable on its own schedule." },
      ],
      links: [
        { label: "open_reserve(rugger)", sig: openSig },
        { label: "post_reserve(rugger, 40)", sig: postSig },
        { label: "initiate_payment(rugger)", sig: b.sig },
      ],
      session: s,
      // The browser counts this down; the escrow cannot be reclaimed before it.
      waitUntil: s.expiry + 2_000,
    };
  }

  /* ---- Act 5 ------------------------------------------------------ */
  if (actNo === 5) {
    const orderB = new BN(s.orderB!);
    const payment = paymentPda(buyer.publicKey, rugger.publicKey, orderB, pid);
    const ruggerReserve = reservePda(rugger.publicKey, pid);
    const ruggerReserveVault = reserveVaultPda(ruggerReserve, pid);

    const sig = await program.methods
      .reclaimTimeout(orderB)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vaultPda(payment, pid),
        buyerToken,
        merchantReserve: ruggerReserve,
        reserveVault: ruggerReserveVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const after = (await getAccount(connection, buyerToken)).amount;
    const recovered = Number(after) - Number(s.beforeReclaim!);
    const reserveAfter: any = await program.account.merchantReserve.fetch(ruggerReserve);
    const reserveBalance = (await getAccount(connection, ruggerReserveVault)).amount;

    return {
      act: 5,
      title: "Surviving the rug: the reserve gets skimmed, the buyer is made whole",
      claim: "Timeout does not just return the escrow — it recovers the instant portion from collateral too.",
      lines: [
        {
          kind: "proof",
          text: `buyer recovered ${fmt(recovered)} in total — the full order, instant portion included, straight out of the rugger's own reserve`,
        },
        { kind: "note", text: `Rugger's reserve balance: ${fmt(reserveBalance)}; locked exposure: ${fmt(reserveAfter.lockedExposure)}.` },
        { kind: "note", text: "No merchant signature anywhere in that transaction. The loss was bounded by what the rugger itself posted." },
        { kind: "note", text: `Buyer's final balance: ${fmt(after)}.` },
      ],
      links: [{ label: "reclaim_timeout(rugger)", sig }],
      session: s,
      done: true,
    };
  }

  throw new Error(`Unknown act ${actNo}`);
}

/* ------------------------------------------------------------------ *
 * Best-effort rate limit. Serverless instances are recycled and there
 * may be several at once, so this narrows abuse rather than preventing
 * it — see web/README.md for the durable (Vercel KV) version.
 * ------------------------------------------------------------------ */
const recent: number[] = [];
const WINDOW_MS = 60_000;
const MAX_RUNS_PER_WINDOW = 6;

function rateLimited(): boolean {
  const now = Date.now();
  while (recent.length && now - recent[0] > WINDOW_MS) recent.shift();
  if (recent.length >= MAX_RUNS_PER_WINDOW) return true;
  recent.push(now);
  return false;
}

export default async function handler(req: Req, res: Res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).json({});
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
  const act = Number(body.act);
  if (!Number.isInteger(act) || act < 0 || act > 5) {
    return res.status(400).json({ error: "act must be an integer from 0 to 5" });
  }

  // Only a new run counts against the limit; continuing one must not be
  // rejected halfway, which would strand the visitor mid-demo.
  if (act === 0 && rateLimited()) {
    return res.status(429).json({
      error: "The live demo is busy — it spends real devnet SOL, so runs are throttled. Try again in a minute.",
    });
  }

  try {
    const session = body.session ? decodeSession(String(body.session)) : null;
    const result = await runAct(act, session);
    return res.status(200).json({ ...result, session: encodeSession(result.session) });
  } catch (e: any) {
    console.error("[x402] act failed:", e);
    const msg = e?.error?.errorMessage ?? e?.message ?? String(e);
    return res.status(500).json({ error: msg });
  }
}
