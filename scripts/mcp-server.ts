/**
 * Agent CTOS escrow — MCP server.
 *
 * Exposes the x402 anti-rug escrow as tools an AI agent can call directly, so
 * an agent can check who it is about to pay, pay them under escrow, and settle
 * or recover the money — without knowing anything about Solana accounts.
 *
 * The server acts as ONE wallet (the local Solana CLI keypair). That wallet is
 * the buyer for payment tools, and the owner for `register_merchant`.
 *
 * Run it:
 *   npm run mcp
 *
 * Wire it into Claude Code:
 *   claude mcp add x402-escrow -- npx ts-node /ABSOLUTE/PATH/scripts/mcp-server.ts
 *
 * Everything logs to stderr — stdout is the MCP transport and must stay clean.
 */

import * as os from "os";

process.env.ANCHOR_WALLET =
  process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`;
process.env.ANCHOR_PROVIDER_URL =
  process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { X402Scoring } from "../target/types/x402_scoring";

// ---------------------------------------------------------------------------
// Scoring constants, mirrored from programs/x402-scoring/src/lib.rs.
//
// These are used ONLY to preview what a payment would cost before sending it.
// The program remains the authority: every real split is computed on-chain.
// ---------------------------------------------------------------------------
const RESERVE_BPS = [10_000, 1_000, 300, 100];
const TIER_MULTIPLIER = [2, 10, 50, 100];
const BASE_RESERVE = 1_000;
const REFUND_RATE_THRESHOLD_BPS = 500;
const RECLAIM_RATE_THRESHOLD_BPS = 300;
const MIN_TX = { tier2: 5, tier3: 20, tier4: 50 };

// ---------------------------------------------------------------------------
// Chain plumbing
// ---------------------------------------------------------------------------

function loadProgram(provider: anchor.AnchorProvider): Program<X402Scoring> {
  const root = path.join(__dirname, "..");
  const idl = JSON.parse(
    fs.readFileSync(path.join(root, "target", "idl", "x402_scoring.json"), "utf8")
  );
  const secretKey = Uint8Array.from(
    JSON.parse(
      fs.readFileSync(path.join(root, "target", "deploy", "x402_scoring-keypair.json"), "utf8")
    )
  );
  const programId = Keypair.fromSecretKey(secretKey).publicKey;
  return new anchor.Program(idl, programId, provider) as Program<X402Scoring>;
}

// "confirmed", not Anchor's default "processed": a load-balanced RPC will
// otherwise answer a read from a node that has not seen the write yet.
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
const wallet = (provider.wallet as anchor.Wallet).payer;
const rpcUrl = provider.connection.rpcEndpoint;

const merchantPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("merchant"), owner.toBuffer()],
    program.programId
  )[0];

const paymentPda = (buyer: PublicKey, merchant: PublicKey, orderId: BN) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("payment"),
      buyer.toBuffer(),
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

function explorer(kind: "tx" | "address", id: string): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (rpcUrl.includes("devnet")) return `${base}?cluster=devnet`;
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  }
  return base;
}

/** Cache mint decimals — they never change and every tool needs them. */
const decimalsCache = new Map<string, number>();
async function decimalsOf(mint: PublicKey): Promise<number> {
  const key = mint.toBase58();
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;
  const info = await getMint(provider.connection, mint);
  decimalsCache.set(key, info.decimals);
  return info.decimals;
}

const toBase = (whole: number, decimals: number) =>
  new BN(Math.round(whole * 10 ** decimals));
const toWhole = (base: BN | bigint | number, decimals: number) => {
  const v =
    typeof base === "bigint" ? Number(base) : typeof base === "number" ? base : base.toNumber();
  return v / 10 ** decimals;
};

// ---------------------------------------------------------------------------
// Preview of the on-chain decision tree (see constants note above)
// ---------------------------------------------------------------------------

function ratesBps(m: any): [number, number] {
  const denom = m.totalSettlementEvents.toNumber();
  if (denom === 0) return [0, 0];
  return [
    Math.floor((m.refundCount.toNumber() * 10_000) / denom),
    Math.floor((m.reclaimCount.toNumber() * 10_000) / denom),
  ];
}

function effectiveTier(m: any): number {
  const [refundBps, reclaimBps] = ratesBps(m);
  const clean =
    refundBps <= REFUND_RATE_THRESHOLD_BPS && reclaimBps <= RECLAIM_RATE_THRESHOLD_BPS;
  const done = m.completedTxCount.toNumber();
  if (done < m.tierFloorTxCount.toNumber()) return 1;
  if (clean && done >= MIN_TX.tier4) return 4;
  if (clean && done >= MIN_TX.tier3) return 3;
  if (clean && done >= MIN_TX.tier2) return 2;
  return 1;
}

function quote(m: any, amountBase: number) {
  const tier = effectiveTier(m);
  const idx = Math.min(Math.max(tier, 1), 4) - 1;
  const avg = m.avgTxSize.toNumber();

  if (m.completedTxCount.toNumber() === 0 || tier === 1) {
    return { tier, escrow: amountBase, forced: false, reason: "tier 1 — full escrow" };
  }
  const ceiling = avg * TIER_MULTIPLIER[idx];
  if (amountBase > ceiling) {
    return {
      tier,
      escrow: amountBase,
      forced: true,
      reason: `size anomaly — ${(amountBase / Math.max(avg, 1)).toFixed(1)}x this merchant's average, over its ${TIER_MULTIPLIER[idx]}x ceiling`,
    };
  }
  const escrow = Math.min(
    Math.floor((amountBase * RESERVE_BPS[idx]) / 10_000) + BASE_RESERVE,
    amountBase
  );
  return { tier, escrow, forced: false, reason: `tier ${tier} — ${RESERVE_BPS[idx] / 100}% + base reserve` };
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

async function fetchMerchant(ownerStr: string) {
  const owner = new PublicKey(ownerStr);
  const pda = merchantPda(owner);
  const account: any = await program.account.merchant.fetch(pda);
  return { owner, pda, account };
}

/** Resolve the associated token account, creating it if the wallet can pay. */
async function ata(mint: PublicKey, owner: PublicKey) {
  const acct = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    wallet,
    mint,
    owner,
    true
  );
  return acct.address;
}

function describeError(e: unknown): string {
  const s = String(e);
  if (s.includes("MintMismatch")) {
    return "This merchant settles in a different token than the one supplied. Each merchant pins one settlement mint at registration.";
  }
  if (s.includes("ReclaimNotYetAvailable")) {
    return "The escrow has not expired yet. Reclaim only becomes available after the payment's expiry timestamp.";
  }
  if (s.includes("InvalidPaymentStatus")) {
    return "This payment has already been settled, refunded, or reclaimed. Each order can only be resolved once.";
  }
  if (s.includes("Account does not exist")) {
    return "No such account on this cluster. Check the merchant owner address and that you are on the right network.";
  }
  return s;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "x402-escrow", version: "0.1.0" });

server.registerTool(
  "check_merchant",
  {
    title: "Check a merchant's on-chain reputation",
    description:
      "Look up a merchant's tier and settlement history before paying them, and preview how a proposed payment would be split between escrow and instant settlement. Read-only — sends no transaction. Call this before pay_merchant whenever the counterparty is unfamiliar or the amount is large.",
    inputSchema: {
      merchant_owner: z.string().describe("The merchant owner's Solana address"),
      amount: z
        .number()
        .positive()
        .optional()
        .describe("Optional order size, in whole tokens, to preview the escrow split for"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ merchant_owner, amount }) => {
    try {
      const { pda, account } = await fetchMerchant(merchant_owner);
      const mint = account.mint as PublicKey;
      const dec = await decimalsOf(mint);
      const [refundBps, reclaimBps] = ratesBps(account);
      const tier = effectiveTier(account);

      const lines = [
        `Merchant ${merchant_owner}`,
        `  tier                 ${tier}${tier !== account.tier ? ` (stored ${account.tier}; recomputed from counters)` : ""}`,
        `  completed orders     ${account.completedTxCount}`,
        `  average order size   ${toWhole(account.avgTxSize, dec)}`,
        `  refunds / reclaims   ${account.refundCount} / ${account.reclaimCount}`,
        `  refund rate          ${(refundBps / 100).toFixed(2)}%  (demotes above 5%)`,
        `  reclaim rate         ${(reclaimBps / 100).toFixed(2)}%  (demotes above 3%)`,
        `  settlement mint      ${mint.toBase58()}`,
        `  account              ${explorer("address", pda.toBase58())}`,
      ];

      if (amount !== undefined) {
        const amountBase = toBase(amount, dec).toNumber();
        const q = quote(account, amountBase);
        lines.push(
          "",
          `Preview for ${amount} tokens:`,
          `  held in escrow       ${toWhole(q.escrow, dec)}  (${((q.escrow / amountBase) * 100).toFixed(1)}%)`,
          `  paid instantly       ${toWhole(amountBase - q.escrow, dec)}`,
          `  reason               ${q.reason}`,
          q.forced ? "  NOTE: this payment exceeds the merchant's own size ceiling, so the tier discount does not apply to it." : ""
        );
      }
      return ok(lines.filter(Boolean).join("\n"));
    } catch (e) {
      return fail(describeError(e));
    }
  }
);

server.registerTool(
  "pay_merchant",
  {
    title: "Pay a merchant under escrow",
    description:
      "Send a payment to a merchant. The program decides how much is held in escrow versus settled instantly, based on that merchant's on-chain history — an unproven merchant receives nothing until delivery is confirmed. Returns the order id needed to settle later. This moves real funds.",
    inputSchema: {
      merchant_owner: z.string().describe("The merchant owner's Solana address"),
      amount: z.number().positive().describe("Order size in whole tokens"),
      timeout_seconds: z
        .number()
        .int()
        .min(60)
        .max(2_592_000)
        .optional()
        .describe("How long before the buyer may reclaim an undelivered order. 60s to 30 days, default 1 hour."),
      order_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Your own order id. Omit to have one generated."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ merchant_owner, amount, timeout_seconds, order_id }) => {
    try {
      const { owner, pda, account } = await fetchMerchant(merchant_owner);
      const mint = account.mint as PublicKey;
      const dec = await decimalsOf(mint);

      const id = new BN(order_id ?? Date.now() % 1_000_000_000);
      const payment = paymentPda(wallet.publicKey, pda, id);
      const vault = vaultPda(payment);

      const sig = await program.methods
        .initiatePayment(toBase(amount, dec), id, new BN(timeout_seconds ?? 3600))
        .accounts({
          payment,
          merchant: pda,
          buyer: wallet.publicKey,
          buyerToken: await ata(mint, wallet.publicKey),
          merchantToken: await ata(mint, owner),
          escrowVault: vault,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([wallet])
        .rpc();

      const p: any = await program.account.payment.fetch(payment);
      return ok(
        [
          `Paid ${amount} tokens to ${merchant_owner}.`,
          "",
          `  order_id             ${id.toString()}   <- keep this to settle the order`,
          `  held in escrow       ${toWhole(p.escrowAmount, dec)}  (${((p.escrowAmount.toNumber() / p.amount.toNumber()) * 100).toFixed(1)}%)`,
          `  paid instantly       ${toWhole(p.instantAmount, dec)}`,
          `  merchant tier        ${p.tierAtPayment}${p.forcedFullEscrow ? "  (tier discount revoked: order far above this merchant's average)" : ""}`,
          `  reclaimable after    ${new Date(p.expiry.toNumber() * 1000).toISOString()}`,
          `  transaction          ${explorer("tx", sig)}`,
          "",
          "Call confirm_delivery once the goods or service arrive. If they never do, call reclaim_payment after the expiry above to take the escrow back — the merchant cannot block it.",
        ].join("\n")
      );
    } catch (e) {
      return fail(describeError(e));
    }
  }
);

server.registerTool(
  "check_payment",
  {
    title: "Check the status of an order",
    description:
      "Look up one of your orders: how much is still held in escrow, whether it has settled, and when it becomes reclaimable. Read-only.",
    inputSchema: {
      merchant_owner: z.string().describe("The merchant owner's Solana address"),
      order_id: z.number().int().positive().describe("The order id returned by pay_merchant"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ merchant_owner, order_id }) => {
    try {
      const { pda, account } = await fetchMerchant(merchant_owner);
      const dec = await decimalsOf(account.mint as PublicKey);
      const payment = paymentPda(wallet.publicKey, pda, new BN(order_id));
      const p: any = await program.account.payment.fetch(payment);
      const status = Object.keys(p.status)[0];
      const expiry = p.expiry.toNumber() * 1000;

      return ok(
        [
          `Order ${order_id} to ${merchant_owner}`,
          `  status               ${status}`,
          `  amount               ${toWhole(p.amount, dec)}`,
          `  held in escrow       ${toWhole(p.escrowAmount, dec)}`,
          `  paid instantly       ${toWhole(p.instantAmount, dec)}`,
          `  expiry               ${new Date(expiry).toISOString()}`,
          status === "escrowHeld"
            ? Date.now() > expiry
              ? "  -> expired: reclaim_payment will return the escrow to you now."
              : `  -> still open: reclaimable in ${Math.ceil((expiry - Date.now()) / 1000)}s if the merchant never delivers.`
            : "  -> already resolved; no further action possible on this order.",
          `  account              ${explorer("address", payment.toBase58())}`,
        ].join("\n")
      );
    } catch (e) {
      return fail(describeError(e));
    }
  }
);

server.registerTool(
  "confirm_delivery",
  {
    title: "Confirm delivery and release the escrow",
    description:
      "Confirm that a merchant delivered. Releases the escrowed funds to them and credits the order to their on-chain history, which is the only thing that raises a merchant's tier. Call this only when you actually received what you paid for.",
    inputSchema: {
      merchant_owner: z.string().describe("The merchant owner's Solana address"),
      order_id: z.number().int().positive().describe("The order id returned by pay_merchant"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ merchant_owner, order_id }) => {
    try {
      const { owner, pda, account } = await fetchMerchant(merchant_owner);
      const mint = account.mint as PublicKey;
      const dec = await decimalsOf(mint);
      const id = new BN(order_id);
      const payment = paymentPda(wallet.publicKey, pda, id);

      const sig = await program.methods
        .confirmDelivery(id)
        .accounts({
          payment,
          merchant: pda,
          buyer: wallet.publicKey,
          escrowVault: vaultPda(payment),
          merchantToken: await ata(mint, owner),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wallet])
        .rpc();

      const m: any = await program.account.merchant.fetch(pda);
      return ok(
        [
          `Order ${order_id} confirmed. Escrow released to the merchant.`,
          `  merchant tier        ${m.tier}`,
          `  completed orders     ${m.completedTxCount}`,
          `  average order size   ${toWhole(m.avgTxSize, dec)}`,
          `  transaction          ${explorer("tx", sig)}`,
        ].join("\n")
      );
    } catch (e) {
      return fail(describeError(e));
    }
  }
);

server.registerTool(
  "refund_payment",
  {
    title: "Cancel an order and take the escrow back",
    description:
      "Cancel before delivery and return the escrowed portion to yourself. Records a refund against the merchant, which counts toward the refund rate that can demote them. The instantly-settled portion, if any, is not recoverable.",
    inputSchema: {
      merchant_owner: z.string().describe("The merchant owner's Solana address"),
      order_id: z.number().int().positive().describe("The order id returned by pay_merchant"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ merchant_owner, order_id }) => {
    try {
      const { pda, account } = await fetchMerchant(merchant_owner);
      const mint = account.mint as PublicKey;
      const dec = await decimalsOf(mint);
      const id = new BN(order_id);
      const payment = paymentPda(wallet.publicKey, pda, id);

      const sig = await program.methods
        .refundEscrow(id)
        .accounts({
          payment,
          merchant: pda,
          buyer: wallet.publicKey,
          escrowVault: vaultPda(payment),
          buyerToken: await ata(mint, wallet.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wallet])
        .rpc();

      const p: any = await program.account.payment.fetch(payment);
      return ok(
        [
          `Order ${order_id} refunded. ${toWhole(p.escrowAmount, dec)} returned to you.`,
          `  transaction          ${explorer("tx", sig)}`,
        ].join("\n")
      );
    } catch (e) {
      return fail(describeError(e));
    }
  }
);

server.registerTool(
  "reclaim_payment",
  {
    title: "Recover escrow from a merchant who never delivered",
    description:
      "After an order's expiry, take the escrowed funds back. Requires no cooperation from the merchant — they cannot block it. Records a reclaim against them, resetting their tier to 1 and imposing a rebuild requirement before they can be trusted again.",
    inputSchema: {
      merchant_owner: z.string().describe("The merchant owner's Solana address"),
      order_id: z.number().int().positive().describe("The order id returned by pay_merchant"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ merchant_owner, order_id }) => {
    try {
      const { pda, account } = await fetchMerchant(merchant_owner);
      const mint = account.mint as PublicKey;
      const dec = await decimalsOf(mint);
      const id = new BN(order_id);
      const payment = paymentPda(wallet.publicKey, pda, id);

      const sig = await program.methods
        .reclaimTimeout(id)
        .accounts({
          payment,
          merchant: pda,
          buyer: wallet.publicKey,
          escrowVault: vaultPda(payment),
          buyerToken: await ata(mint, wallet.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wallet])
        .rpc();

      const p: any = await program.account.payment.fetch(payment);
      const m: any = await program.account.merchant.fetch(pda);
      return ok(
        [
          `Order ${order_id} reclaimed. ${toWhole(p.escrowAmount, dec)} recovered.`,
          `  merchant tier        ${m.tier}  (reset)`,
          `  reclaims on record   ${m.reclaimCount}`,
          `  must now settle      ${m.tierFloorTxCount} clean orders before any promotion`,
          `  transaction          ${explorer("tx", sig)}`,
          "",
          "This is permanent public history against that merchant address.",
        ].join("\n")
      );
    } catch (e) {
      return fail(describeError(e));
    }
  }
);

server.registerTool(
  "register_merchant",
  {
    title: "Register this wallet as a merchant",
    description:
      "Register the server's own wallet as a merchant that accepts payments in one SPL token. Starts at tier 1 with no history, meaning buyers' payments are fully escrowed until orders are delivered. Trust is earned only by settling orders.",
    inputSchema: {
      mint: z
        .string()
        .describe("The SPL token mint this merchant will settle in, fixed permanently at registration"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ mint }) => {
    try {
      const mintKey = new PublicKey(mint);
      const pda = merchantPda(wallet.publicKey);
      const sig = await program.methods
        .registerMerchant()
        .accounts({
          merchant: pda,
          owner: wallet.publicKey,
          mint: mintKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();

      return ok(
        [
          `Registered ${wallet.publicKey.toBase58()} as a merchant.`,
          `  tier                 1  (no history — buyers' funds are fully escrowed)`,
          `  settlement mint      ${mintKey.toBase58()}`,
          `  account              ${explorer("address", pda.toBase58())}`,
          `  transaction          ${explorer("tx", sig)}`,
          "",
          "Five delivered orders reach tier 2, where only ~10% of each payment is held.",
        ].join("\n")
      );
    } catch (e) {
      return fail(describeError(e));
    }
  }
);

async function main() {
  console.error(
    `x402-escrow MCP server — program ${program.programId.toBase58()} on ${rpcUrl}, wallet ${wallet.publicKey.toBase58()}`
  );
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
