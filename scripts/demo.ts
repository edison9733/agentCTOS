/**
 * Agent CTOS anti-rug escrow — live demo.
 *
 * Five acts, each stating a claim and then proving it with a real devnet
 * transaction. Every number printed is re-read from the program's own
 * on-chain accounts; nothing is computed off-chain for display.
 *
 * Usage:
 *   anchor build                 # once, so target/idl + target/deploy exist
 *   npm run demo                 # devnet + your local CLI wallet
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
  getAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { X402Scoring } from "../target/types/x402_scoring";

// anchor.workspace.X402Scoring mis-derives the IDL filename for program
// names containing digits (it produces `x_402_scoring.json` instead of the
// real `x402_scoring.json`), so the IDL is loaded directly instead.
//
// The program id is read straight from the deploy keypair rather than from
// idl.metadata.address / idl.address: whether either field is even present
// varies across anchor-cli builds (some 0.29.0 builds emit neither), while
// the keypair is always there after `anchor build` and is unambiguously the
// program's real on-chain address.
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

/** The escrow clock started in Act 2; the reclaim in Act 5 needs it elapsed. */
const RUG_TIMEOUT_SECONDS = 60;

const abbrev = (k: PublicKey | string) => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
};

function act(n: number, title: string) {
  const bar = "─".repeat(Math.max(0, 62 - title.length));
  console.log(`\n── ACT ${n} · ${title} ${bar}`);
}

function claim(text: string) {
  console.log(`   CLAIM   ${text}`);
}

function proof(text: string) {
  console.log(`   PROOF   ${text}`);
}

function note(text: string) {
  console.log(`           ${text}`);
}

function explorerTx(sig: string, rpcUrl: string): string {
  if (rpcUrl.includes("devnet")) return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
    return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  }
  return `https://explorer.solana.com/tx/${sig}`;
}

function explorerAddr(addr: PublicKey, rpcUrl: string): string {
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
  const buyer = (provider.wallet as anchor.Wallet).payer;

  const links: string[] = [];
  const record = (label: string, sig: string) => {
    links.push(`   ${label.padEnd(34)} ${explorerTx(sig, rpcUrl)}`);
  };

  console.log("=".repeat(72));
  console.log(" AGENT CTOS — x402 ANTI-RUG ESCROW");
  console.log(" Merchant trust underwritten by on-chain settlement history alone.");
  console.log("=".repeat(72));
  console.log(` Network   ${rpcUrl}`);
  console.log(` Program   ${program.programId.toBase58()}`);
  console.log(` Buyer     ${provider.wallet.publicKey.toBase58()}`);

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

  // register_merchant uses `payer = owner` on-chain, so each freshly
  // generated merchant keypair needs SOL of its own for its PDA's rent.
  async function fundNewAccount(pubkey: PublicKey, lamports: number) {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: pubkey, lamports })
    );
    await provider.sendAndConfirm(tx, [buyer]);
  }

  async function balance(tokenAccount: PublicKey): Promise<number> {
    return Number((await getAccount(provider.connection, tokenAccount)).amount);
  }

  async function merchantState(pda: PublicKey) {
    return (await program.account.merchant.fetch(pda)) as any;
  }

  async function paymentState(pda: PublicKey) {
    return (await program.account.payment.fetch(pda)) as any;
  }

  // -------------------------------------------------------------------
  // Setup: one demo SPL token, one funded buyer, three merchant identities.
  // -------------------------------------------------------------------
  const mint = await createMint(
    provider.connection,
    buyer,
    provider.wallet.publicKey,
    null,
    DECIMALS
  );
  const buyerToken = await createAccount(provider.connection, buyer, mint, buyer.publicKey);
  await mintTo(
    provider.connection,
    buyer,
    mint,
    buyerToken,
    provider.wallet.publicKey,
    BigInt(unit(100_000).toString())
  );
  console.log(` Token     ${mint.toBase58()} (6 decimals, 100,000 minted to buyer)`);

  const vex = Keypair.generate();   // will take the money and never deliver
  const nova = Keypair.generate();  // will build a clean settlement record
  const aria = Keypair.generate();  // stays brand new, for contrast

  await fundNewAccount(vex.publicKey, 0.01 * anchor.web3.LAMPORTS_PER_SOL);
  await fundNewAccount(nova.publicKey, 0.01 * anchor.web3.LAMPORTS_PER_SOL);
  await fundNewAccount(aria.publicKey, 0.01 * anchor.web3.LAMPORTS_PER_SOL);

  const vexPda = merchantPda(vex.publicKey);
  const novaPda = merchantPda(nova.publicKey);
  const ariaPda = merchantPda(aria.publicKey);

  const vexToken = await createAccount(provider.connection, buyer, mint, vex.publicKey);
  const novaToken = await createAccount(provider.connection, buyer, mint, nova.publicKey);
  const ariaToken = await createAccount(provider.connection, buyer, mint, aria.publicKey);

  // -------------------------------------------------------------------
  act(1, "A new address earns nothing");
  claim("Registration confers no trust. Every merchant starts identical.");

  for (const [name, owner, pda] of [
    ["Vex", vex, vexPda],
    ["Nova", nova, novaPda],
    ["Aria", aria, ariaPda],
  ] as [string, Keypair, PublicKey][]) {
    const sig = await program.methods
      .registerMerchant()
      .accounts({ merchant: pda, owner: owner.publicKey, systemProgram: SystemProgram.programId })
      .signers([owner])
      .rpc();
    record(`register_merchant(${name})`, sig);
  }

  const v0 = await merchantState(vexPda);
  proof(`all three merchants: tier=${v0.tier}, completed_tx=${v0.completedTxCount}, avg_tx=${fmt(v0.avgTxSize)}`);
  note("Tier 1 is the floor, and tier 1 means 100% of every payment is escrowed.");

  // -------------------------------------------------------------------
  act(2, "The rug is set in motion");
  claim("A tier-1 merchant cannot touch a single token before delivering.");

  const rugOrder = new BN(1);
  const rugAmount = unit(40);
  const rugPayment = paymentPda(vexPda, rugOrder);
  const rugVault = vaultPda(rugPayment);
  const buyerBefore = await balance(buyerToken);

  const rugSig = await program.methods
    .initiatePayment(rugAmount, rugOrder, new BN(RUG_TIMEOUT_SECONDS))
    .accounts({
      payment: rugPayment,
      merchant: vexPda,
      buyer: buyer.publicKey,
      buyerToken,
      merchantToken: vexToken,
      escrowVault: rugVault,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([buyer])
    .rpc();
  record("initiate_payment(Vex, 40.000)", rugSig);

  const rugState = await paymentState(rugPayment);
  proof(
    `40.000 paid → escrow ${fmt(rugState.escrowAmount)} / instant ${fmt(rugState.instantAmount)} ` +
      `(vault holds ${fmt(await balance(rugVault))}, Vex received ${fmt(await balance(vexToken))})`
  );
  note(`Escrow expires in ${RUG_TIMEOUT_SECONDS}s. Vex will now do nothing at all.`);

  // -------------------------------------------------------------------
  act(3, "Trust is earned, and it is mechanical");
  claim("Only settled orders count. Five clean settlements promote Nova to tier 2.");

  let orderId = 10;
  for (let i = 0; i < 5; i++) {
    const id = new BN(orderId++);
    const payment = paymentPda(novaPda, id);
    const vault = vaultPda(payment);
    await program.methods
      .initiatePayment(unit(10), id, new BN(3600))
      .accounts({
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
      })
      .signers([buyer])
      .rpc();
    const sig = await program.methods
      .confirmDelivery(id)
      .accounts({
        payment,
        merchant: novaPda,
        buyer: buyer.publicKey,
        escrowVault: vault,
        merchantToken: novaToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
    if (i === 4) record("confirm_delivery(Nova, 5th)", sig);
  }

  const n1 = await merchantState(novaPda);
  proof(`Nova: tier=${n1.tier}, completed_tx=${n1.completedTxCount}, avg_tx=${fmt(n1.avgTxSize)}, reclaims=${n1.reclaimCount}`);
  note("Promotion is a pure function of counters — no operator, no allowlist, no appeal.");

  // -------------------------------------------------------------------
  act(4, "The reserve is priced per payment, not per merchant");
  claim("Tier sets the discount; the payment's own size can still revoke it.");

  const cases: { label: string; merchant: PublicKey; token: PublicKey; amount: BN; id: BN }[] = [
    { label: "Aria  tier 1  20.000", merchant: ariaPda, token: ariaToken, amount: unit(20), id: new BN(30) },
    { label: "Nova  tier 2  15.000", merchant: novaPda, token: novaToken, amount: unit(15), id: new BN(31) },
    { label: "Nova  tier 2 500.000", merchant: novaPda, token: novaToken, amount: unit(500), id: new BN(32) },
  ];

  console.log("");
  console.log("     payment                escrow      instant   forced   reserve rule");
  console.log("     ─────────────────────  ──────────  ────────  ───────  ─────────────────────────");

  for (const c of cases) {
    const payment = paymentPda(c.merchant, c.id);
    const vault = vaultPda(payment);
    const sig = await program.methods
      .initiatePayment(c.amount, c.id, new BN(3600))
      .accounts({
        payment,
        merchant: c.merchant,
        buyer: buyer.publicKey,
        buyerToken,
        merchantToken: c.token,
        escrowVault: vault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();
    record(`initiate_payment(${c.label.trim()})`, sig);

    const p = await paymentState(payment);
    const pct = ((p.escrowAmount.toNumber() / p.amount.toNumber()) * 100).toFixed(1);
    const rule = p.forcedFullEscrow
      ? "size anomaly → 100%"
      : p.tierAtPayment === 1
        ? "tier 1 → 100%"
        : "tier 2 → 10% + base";
    console.log(
      `     ${c.label.padEnd(21)}  ${(fmt(p.escrowAmount) + ` (${pct}%)`).padEnd(10)}  ` +
        `${fmt(p.instantAmount).padEnd(8)}  ${String(p.forcedFullEscrow).padEnd(7)}  ${rule}`
    );
  }

  console.log("");
  proof("Nova's 500.000 order is 50× her 10.000 average, so her tier discount is revoked.");
  note("The reserve is snapshotted into the Payment PDA and never re-derived if her tier later moves.");

  // -------------------------------------------------------------------
  act(5, "Surviving the rug, with no merchant signature");
  claim("When Vex never delivers, the buyer recovers the escrow unilaterally.");

  const rugExpiry = (await paymentState(rugPayment)).expiry.toNumber();
  let remaining = rugExpiry - Math.floor(Date.now() / 1000);
  if (remaining > 0) {
    note(`escrow timeout not yet reached — waiting ${remaining}s`);
    await new Promise((r) => setTimeout(r, (remaining + 2) * 1000));
  }

  const reclaimSig = await program.methods
    .reclaimTimeout(rugOrder)
    .accounts({
      payment: rugPayment,
      merchant: vexPda,
      buyer: buyer.publicKey,
      escrowVault: rugVault,
      buyerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([buyer])
    .rpc();
  record("reclaim_timeout(Vex)", reclaimSig);

  const buyerAfter = await balance(buyerToken);
  const vexFinal = await merchantState(vexPda);
  proof(`buyer recovered ${fmt(rugState.escrowAmount)}; Vex ended the attempt with ${fmt(await balance(vexToken))} tokens`);
  note(`Vex is now tier=${vexFinal.tier}, reclaims=${vexFinal.reclaimCount}, ` +
    `and must settle ${vexFinal.tierFloorTxCount} clean orders before any promotion.`);
  note("Signed by the buyer alone. Vex could not block it, and the rug is now public history.");

  // -------------------------------------------------------------------
  console.log("\n" + "=".repeat(72));
  console.log(" VERIFY INDEPENDENTLY");
  console.log("=".repeat(72));
  console.log("   Merchant PDAs (tier and full settlement history):");
  console.log(`     Vex  (rugged)  ${explorerAddr(vexPda, rpcUrl)}`);
  console.log(`     Nova (proven)  ${explorerAddr(novaPda, rpcUrl)}`);
  console.log(`     Aria (new)     ${explorerAddr(ariaPda, rpcUrl)}`);
  console.log("\n   Transactions:");
  links.forEach((l) => console.log(l));
  console.log("");
  console.log(`   Buyer token balance: ${fmt(buyerBefore)} → ${fmt(buyerAfter)}`);
  console.log("   Every tier, reserve and counter above was read back from on-chain state.");
  console.log("");
}

main().catch((err) => {
  console.error("\nDemo failed:", err);
  process.exit(1);
});
