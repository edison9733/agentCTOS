/**
 * Seeds devnet with the persistent demo merchants that the website reads.
 *
 * Unlike `npm run demo`, which generates throwaway actors per run, everything
 * here is stable across runs: the same mint address, the same merchant
 * pubkeys, the same reserves. That is what lets a site list a catalog that is
 * still there tomorrow.
 *
 * Secret keys come from .demo-wallets/ (gitignored). Public addresses are in
 * frontend/merchants.json, which is what the site actually loads.
 *
 *   npx ts-node scripts/seed-devnet.ts
 *
 * Idempotent: re-running tops reserves back up instead of failing.
 */

import * as os from "os";

process.env.ANCHOR_WALLET =
  process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`;
process.env.ANCHOR_PROVIDER_URL =
  process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const WALLETS = path.join(ROOT, ".demo-wallets");
const MANIFEST = path.join(ROOT, "frontend", "merchants.json");

const DECIMALS = 6;
const unit = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));
const fmt = (v: bigint | number) => (Number(v) / 10 ** DECIMALS).toFixed(2);

/** Lamports each merchant needs to pay rent on its own reserve PDA and vault. */
const MERCHANT_SOL = 20_000_000;
/** Working supply minted to the operator, to hand out to demo buyers. */
const OPERATOR_SUPPLY = 100_000;

const TRANSIENT =
  /blockhash not found|block height exceeded|blockhash expired|429|too many requests|timed out|timeout|socket hang up|fetch failed|ECONNRESET|node is behind/i;

async function rpc<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = `${e?.message ?? e} ${e?.transactionMessage ?? ""}`;
      if (!TRANSIENT.test(msg) || i === attempts) throw e;
      const backoff = Math.min(500 * 2 ** (i - 1), 8_000);
      console.log(`    (${label}: transient RPC error, retry ${i} in ${backoff}ms)`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

const pace = () => new Promise((r) => setTimeout(r, 300));

function loadKeypair(file: string): Keypair {
  const p = path.join(WALLETS, file);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Missing ${p}. The demo wallets were never generated, or .demo-wallets/ was not carried over.`
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function loadProgram(provider: anchor.AnchorProvider): anchor.Program {
  // Prefer the fresh build, fall back to the committed copy so this runs
  // without `anchor build` on a machine that only has the repo.
  const candidates = [
    path.join(ROOT, "target", "idl", "x402_scoring.json"),
    path.join(ROOT, "idl", "x402_scoring.json"),
  ];
  const idlPath = candidates.find((p) => fs.existsSync(p));
  if (!idlPath) {
    throw new Error(
      "No IDL found. Run `anchor build`, or commit one with `npm run sync-idl`."
    );
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = new PublicKey(
    process.env.DEMO_PROGRAM_ID || "HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4"
  );
  return new anchor.Program(idl, programId, provider);
}

function redact(url: string): string {
  return url.replace(/([?&]api-key=)[^&]+/i, "$1***");
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = loadProgram(provider);
  const payer = (provider.wallet as anchor.Wallet).payer;
  const conn = provider.connection;

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const mintKp = loadKeypair("mint.json");

  const reservePda = (merchant: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("reserve"), merchant.toBuffer()],
      program.programId
    )[0];
  const reserveVaultPda = (reserve: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("reserve_vault"), reserve.toBuffer()],
      program.programId
    )[0];

  console.log("=".repeat(72));
  console.log(" SEEDING PERSISTENT DEMO MERCHANTS");
  console.log("=".repeat(72));
  console.log(` Network   ${redact(provider.connection.rpcEndpoint)}`);
  console.log(` Program   ${program.programId.toBase58()}`);
  console.log(` Operator  ${payer.publicKey.toBase58()}`);

  const solBalance = await rpc("getBalance", () => conn.getBalance(payer.publicKey));
  console.log(` Balance   ${(solBalance / 1e9).toFixed(3)} SOL`);
  if (solBalance < 200_000_000) {
    console.log("\n  Low balance. Seeding needs roughly 0.2 SOL. Top up first:");
    console.log(`  solana airdrop 2 ${payer.publicKey.toBase58()} --url devnet`);
    process.exit(1);
  }

  // --- the shared mint ---------------------------------------------------
  let mint = mintKp.publicKey;
  let mintExists = true;
  try {
    await getMint(conn, mint);
  } catch {
    mintExists = false;
  }
  if (!mintExists) {
    await rpc("createMint", () =>
      createMint(conn, payer, payer.publicKey, null, DECIMALS, mintKp)
    );
    await pace();
    console.log(`\n  mint created   ${mint.toBase58()}`);
  } else {
    console.log(`\n  mint exists    ${mint.toBase58()}`);
  }

  // Working supply the operator hands to demo buyers (human or agent).
  const operatorToken = await rpc("operatorAta", () =>
    getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey)
  );
  await pace();
  if (Number(operatorToken.amount) < Number(unit(OPERATOR_SUPPLY / 2))) {
    await rpc("mintOperator", () =>
      mintTo(
        conn,
        payer,
        mint,
        operatorToken.address,
        payer.publicKey,
        BigInt(unit(OPERATOR_SUPPLY).toString())
      )
    );
    await pace();
    console.log(`  minted ${OPERATOR_SUPPLY} to operator ${operatorToken.address.toBase58()}`);
  }

  // --- merchants ---------------------------------------------------------
  const out: any[] = [];

  for (const m of manifest.merchants) {
    console.log(`\n── ${m.name} ${"─".repeat(Math.max(0, 50 - m.name.length))}`);
    const kp = loadKeypair(`merchant-${m.id}.json`);
    if (kp.publicKey.toBase58() !== m.pubkey) {
      throw new Error(
        `Key mismatch for ${m.id}: manifest says ${m.pubkey}, keyfile is ${kp.publicKey.toBase58()}`
      );
    }
    console.log(`   pubkey        ${kp.publicKey.toBase58()}`);

    const bal = await rpc("getBalance", () => conn.getBalance(kp.publicKey));
    if (bal < MERCHANT_SOL / 2) {
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: kp.publicKey,
          lamports: MERCHANT_SOL,
        })
      );
      await rpc("fundSol", () => provider.sendAndConfirm(tx));
      await pace();
      console.log(`   funded        ${(MERCHANT_SOL / 1e9).toFixed(3)} SOL`);
    }

    const merchantToken = await rpc("merchantAta", () =>
      getOrCreateAssociatedTokenAccount(conn, payer, mint, kp.publicKey)
    );
    await pace();
    console.log(`   token acct    ${merchantToken.address.toBase58()}`);

    const entry: any = {
      ...m,
      tokenAccount: merchantToken.address.toBase58(),
    };

    if (!m.reserve || m.reserve <= 0) {
      console.log(`   reserve       none — stays uncollateralized by design`);
      out.push(entry);
      continue;
    }

    const reserve = reservePda(kp.publicKey);
    const reserveVault = reserveVaultPda(reserve);
    entry.reserve_pda = reserve.toBase58();
    entry.reserve_vault = reserveVault.toBase58();

    let reserveExists = true;
    try {
      await (program.account as any).merchantReserve.fetch(reserve);
    } catch {
      reserveExists = false;
    }
    if (!reserveExists) {
      await rpc("openReserve", () =>
        program.methods
          .openReserve()
          .accounts({
            reserve,
            merchant: kp.publicKey,
            reserveVault,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([kp])
          .rpc()
      );
      await pace();
      console.log(`   reserve       opened at ${reserve.toBase58()}`);
    }

    const held = Number((await rpc("vault", () => getAccount(conn, reserveVault))).amount);
    const want = Number(unit(m.reserve).toString());
    if (held < want) {
      const shortfall = want - held;
      await rpc("mintMerchant", () =>
        mintTo(
          conn,
          payer,
          mint,
          merchantToken.address,
          payer.publicKey,
          BigInt(shortfall)
        )
      );
      await pace();
      await rpc("postReserve", () =>
        program.methods
          .postReserve(new BN(shortfall))
          .accounts({
            reserve,
            merchant: kp.publicKey,
            reserveVault,
            merchantToken: merchantToken.address,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([kp])
          .rpc()
      );
      await pace();
    }
    const now = (await rpc("vault", () => getAccount(conn, reserveVault))).amount;
    console.log(`   collateral    ${fmt(now)} tokens posted`);
    out.push(entry);
  }

  // Write the addresses back so the site has the derived accounts too.
  const updated = { ...manifest, mint: mint.toBase58(), merchants: out };
  fs.writeFileSync(MANIFEST, JSON.stringify(updated, null, 2) + "\n");

  console.log("\n" + "=".repeat(72));
  console.log(" DONE — frontend/merchants.json updated");
  console.log("=".repeat(72));
  console.log(` Mint on Solscan`);
  console.log(`   https://solscan.io/token/${mint.toBase58()}?cluster=devnet`);
  for (const m of out) {
    console.log(` ${m.name}`);
    console.log(`   https://solscan.io/account/${m.pubkey}?cluster=devnet`);
  }
  console.log("\n To give a buyer tokens to spend:");
  console.log(
    `   spl-token transfer ${mint.toBase58()} 100 <BUYER_PUBKEY> --fund-recipient --url devnet`
  );
}

main().catch((e) => {
  console.error("\nSeeding failed:", e?.message ?? e);
  process.exit(1);
});
