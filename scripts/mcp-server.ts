/**
 * Agent CTOS x402 escrow — MCP server.
 *
 * Exposes the escrow as tools an AI agent can call directly, so an agent can
 * pay a stranger without the payment being irreversible, and recover the money
 * if nothing is delivered.
 *
 * The server acts as ONE wallet (the local Solana CLI keypair), always as the
 * buyer.
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
  getOrCreateAssociatedTokenAccount as rawGetOrCreateAta,
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

/**
 * Transient RPC failures — a blockhash the receiving node hasn't caught up to
 * (load-balanced providers route the fetch and the send to different backends),
 * rate limits, socket timeouts. All clear on a retry, because a retry fetches a
 * fresh blockhash. A real program error is deliberately NOT in this list: it is
 * rethrown at once, so a genuine failure still reaches the agent as a failed
 * tool call with a useful message instead of being retried away.
 *
 * This matters more here than in the one-shot scripts. The server is
 * long-running, so every transient blip over its whole lifetime would
 * otherwise surface to the calling agent as a tool failure.
 */
const TRANSIENT =
  /blockhash not found|block height exceeded|blockhash expired|429|too many requests|timed out|timeout|socket hang up|fetch failed|econnreset|node is behind|failed to get/i;

/**
 * web3.js caches the blockhash for 30s and `connection.sendTransaction` — the
 * path the spl-token helpers take — reads that cache. The whole backoff
 * schedule below fits inside 30s, so without this a retry would replay the
 * exact blockhash that just failed. Dropping the cache forces a fresh one.
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
      // stderr, never stdout: stdout is the MCP transport and must stay clean.
      console.error(`[x402] ${label}: transient RPC error, retrying in ${backoff}ms`);
      freshenBlockhash(conn);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/** A breath after each send, so a burst of tool calls doesn't earn a 429. */
const pace = () => new Promise((r) => setTimeout(r, 300));

// Every `program.methods...rpc()` in this file funnels through
// provider.sendAndConfirm, and every `program.account.*.fetch` (and getMint)
// through connection.getAccountInfo. Wrapping those two chokepoints covers
// them all at once, with no change at any call site.
const sendAndConfirm = provider.sendAndConfirm.bind(provider);
(provider as any).sendAndConfirm = async (tx: any, signers?: any, opts?: any) => {
  const sig = await rpc("tx", () => sendAndConfirm(tx, signers, opts), connection);
  await pace();
  return sig;
};
const getAccountInfo = connection.getAccountInfo.bind(connection);
(connection as any).getAccountInfo = (pubkey: any, cfg?: any) =>
  rpc("getAccountInfo", () => getAccountInfo(pubkey, cfg), connection);

// The spl-token helper sends its own transaction through its own
// sendAndConfirmTransaction, so the provider wrapper above never sees it.
const getOrCreateAssociatedTokenAccount: typeof rawGetOrCreateAta = async (...args) => {
  const r = await rpc("getOrCreateAta", () => rawGetOrCreateAta(...args), args[0]);
  await pace();
  return r;
};

const program = loadProgram(provider);
const wallet = (provider.wallet as anchor.Wallet).payer;
const rpcUrl = provider.connection.rpcEndpoint;

const paymentPda = (merchant: PublicKey, orderId: BN) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("payment"),
      wallet.publicKey.toBuffer(),
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

const reservePda = (merchant: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("reserve"), merchant.toBuffer()], program.programId)[0];

const reserveVaultPda = (reserve: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("reserve_vault"), reserve.toBuffer()], program.programId)[0];

const standingPda = (buyer: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("standing"), buyer.toBuffer()], program.programId)[0];

// RPC endpoints carry a provider API key — Helius and Ankr in the query
// string, Alchemy and QuickNode in the path. Never print the endpoint raw:
// this banner goes to stderr, which an MCP client surfaces in its logs.
function redactRpc(url: string): string {
  let out = url.replace(
    /([?&](?:api[-_]?key|key|token|access[-_]?token)=)[^&]*/gi,
    "$1REDACTED"
  );
  try {
    const u = new URL(out);
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && /^[A-Za-z0-9_-]{16,}$/.test(last)) {
      segments[segments.length - 1] = "REDACTED";
      u.pathname = `/${segments.join("/")}`;
      out = u.toString();
    }
  } catch {
    // Not a parseable URL; the query-string pass above still applied.
  }
  return out;
}

function explorer(kind: "tx" | "address", id: string): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  if (rpcUrl.includes("devnet")) return `${base}?cluster=devnet`;
  if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  }
  return base;
}

// Must match TREASURY in programs/x402-scoring/src/lib.rs. Compiled into the
// program, so it cannot be redirected by a caller.
const TREASURY = new PublicKey("5i7zzV9hQUCbpg8MXSNJB3QQkL6zscDd8VQKow46vg7E");

const decimalsCache = new Map<string, number>();
async function decimalsOf(mint: PublicKey): Promise<number> {
  const key = mint.toBase58();
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;
  const info = await getMint(provider.connection, mint);
  decimalsCache.set(key, info.decimals);
  return info.decimals;
}

const toBase = (whole: number, decimals: number) => new BN(Math.round(whole * 10 ** decimals));
const toWhole = (base: BN | bigint | number, decimals: number) => {
  const v =
    typeof base === "bigint" ? Number(base) : typeof base === "number" ? base : base.toNumber();
  return v / 10 ** decimals;
};

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

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
  if (s.includes("ReclaimNotYetAvailable")) {
    return "The escrow has not expired yet. Reclaim only works after the payment's expiry timestamp — use check_payment to see when that is.";
  }
  if (s.includes("InvalidPaymentStatus")) {
    return "This order is already settled, refunded, or reclaimed. Each order resolves once.";
  }
  if (s.includes("PaymentStillOpen")) {
    return "The escrow is still held. Settle the order before closing its record.";
  }
  if (s.includes("InvalidTimeout")) {
    return "Timeout must be between 60 seconds and 30 days.";
  }
  if (s.includes("already in use")) {
    return "That order id has already been used for this merchant. Choose another.";
  }
  if (s.includes("Account does not exist")) {
    return "No such order on this cluster. Check the merchant address and order id.";
  }
  return s;
}

const server = new McpServer({ name: "x402-escrow", version: "0.2.0" });

server.registerTool(
  "pay_merchant",
  {
    title: "Pay a merchant, with the money held in escrow",
    description:
      "Pay a merchant for an order. The full amount is held in escrow — the merchant receives nothing until you confirm delivery, and you can take the money back yourself if they never deliver. Use this instead of a plain transfer whenever the merchant is not already trusted. Returns the order id needed to settle. Moves real funds.",
    inputSchema: {
      merchant: z.string().describe("The merchant's Solana address"),
      mint: z.string().describe("The SPL token mint to pay in"),
      amount: z.number().positive().describe("Order size in whole tokens"),
      timeout_seconds: z
        .number()
        .int()
        .min(60)
        .max(2_592_000)
        .optional()
        .describe("How long until you may reclaim an undelivered order. 60s to 30 days, default 1 hour."),
      order_id: z.number().int().positive().optional().describe("Your own order id; omit to generate one"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ merchant, mint, amount, timeout_seconds, order_id }) => {
    try {
      const merchantKey = new PublicKey(merchant);
      const mintKey = new PublicKey(mint);
      const dec = await decimalsOf(mintKey);
      const id = new BN(order_id ?? Date.now() % 1_000_000_000);
      const payment = paymentPda(merchantKey, id);

      const reserve = reservePda(merchantKey);
      const sig = await program.methods
        .initiatePayment(toBase(amount, dec), id, new BN(timeout_seconds ?? 3600))
        .accounts({
          payment,
          merchant: merchantKey,
          buyer: wallet.publicKey,
          buyerToken: await ata(mintKey, wallet.publicKey),
          merchantToken: await ata(mintKey, merchantKey),
          escrowVault: vaultPda(payment),
          merchantReserve: reserve,
          reserveVault: reserveVaultPda(reserve),
          buyerStanding: standingPda(wallet.publicKey),
          mint: mintKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([wallet])
        .rpc();

      const p: any = await program.account.payment.fetch(payment);
      const instant = toWhole(p.instantAmount, dec);
      return ok(
        [
          `Paid ${amount} tokens to ${merchant}.`,
          "",
          `  order_id             ${id.toString()}   <- keep this to settle the order`,
          instant > 0
            ? `  paid instantly       ${instant}  (covered by the merchant's own posted reserve)`
            : `  held in escrow       ${toWhole(p.escrowedAmount, dec)}`,
          `  reclaimable after    ${new Date(p.expiry.toNumber() * 1000).toISOString()}`,
          `  transaction          ${explorer("tx", sig)}`,
          "",
          "Call confirm_delivery when the goods arrive. If they never do, call reclaim_payment after the time above — the merchant cannot block it, and if any part was paid instantly, that part is recovered from the merchant's own posted collateral too.",
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
      "Look up one of your orders: how much is still held in escrow, whether it settled, and whether it can be reclaimed yet. Read-only.",
    inputSchema: {
      merchant: z.string().describe("The merchant's Solana address"),
      order_id: z.number().int().positive().describe("The order id returned by pay_merchant"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ merchant, order_id }) => {
    try {
      const payment = paymentPda(new PublicKey(merchant), new BN(order_id));
      const p: any = await program.account.payment.fetch(payment);
      const dec = await decimalsOf(p.mint as PublicKey);
      const status = Object.keys(p.status)[0];
      const expiry = p.expiry.toNumber() * 1000;

      return ok(
        [
          `Order ${order_id} to ${merchant}`,
          `  status               ${status}`,
          `  amount               ${toWhole(p.amount, dec)}`,
          `  mint                 ${(p.mint as PublicKey).toBase58()}`,
          `  expiry               ${new Date(expiry).toISOString()}`,
          status === "escrowHeld"
            ? Date.now() > expiry
              ? "  -> expired: reclaim_payment will return the money to you now."
              : `  -> open: reclaimable in ${Math.ceil((expiry - Date.now()) / 1000)}s if nothing is delivered.`
            : "  -> resolved. You can call close_order to reclaim the record's rent.",
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
      "Confirm the merchant delivered, releasing the escrowed funds to them. Only call this once you actually received what you paid for — it is irreversible, and afterwards only the merchant can return the money.",
    inputSchema: {
      merchant: z.string().describe("The merchant's Solana address"),
      order_id: z.number().int().positive().describe("The order id returned by pay_merchant"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ merchant, order_id }) => {
    try {
      const merchantKey = new PublicKey(merchant);
      const id = new BN(order_id);
      const payment = paymentPda(merchantKey, id);
      const p: any = await program.account.payment.fetch(payment);
      const mintKey = p.mint as PublicKey;
      const dec = await decimalsOf(mintKey);

      const sig = await program.methods
        .confirmDelivery(id)
        .accounts({
          payment,
          buyer: wallet.publicKey,
          escrowVault: vaultPda(payment),
          merchantToken: await ata(mintKey, merchantKey),
          treasuryToken: await ata(mintKey, TREASURY),
          merchantReserve: reservePda(merchantKey),
          buyerStanding: standingPda(wallet.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wallet])
        .rpc();

      return ok(
        [
          `Order ${order_id} confirmed. ${toWhole(p.amount, dec)} released, less a 0.50% settlement fee.`,
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
    title: "Recover money from a merchant who never delivered",
    description:
      "After an order's expiry has passed, take the escrowed funds back. Requires no cooperation from the merchant — they cannot block or delay it. This is the protection that makes it safe to pay an unknown merchant.",
    inputSchema: {
      merchant: z.string().describe("The merchant's Solana address"),
      order_id: z.number().int().positive().describe("The order id returned by pay_merchant"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ merchant, order_id }) => {
    try {
      const id = new BN(order_id);
      const payment = paymentPda(new PublicKey(merchant), id);
      const p: any = await program.account.payment.fetch(payment);
      const mintKey = p.mint as PublicKey;
      const dec = await decimalsOf(mintKey);

      const merchantKey = new PublicKey(merchant);
      const reserve = reservePda(merchantKey);
      const sig = await program.methods
        .reclaimTimeout(id)
        .accounts({
          payment,
          buyer: wallet.publicKey,
          escrowVault: vaultPda(payment),
          buyerToken: await ata(mintKey, wallet.publicKey),
          merchantReserve: reserve,
          reserveVault: reserveVaultPda(reserve),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([wallet])
        .rpc();

      return ok(
        [
          `Order ${order_id} reclaimed. ${toWhole(p.amount, dec)} recovered.`,
          `  transaction          ${explorer("tx", sig)}`,
          "",
          "Signed by you alone. The merchant was not asked and could not object.",
        ].join("\n")
      );
    } catch (e) {
      return fail(describeError(e));
    }
  }
);

server.registerTool(
  "close_order",
  {
    title: "Reclaim the rent of a finished order",
    description:
      "Delete the on-chain record of a settled, refunded or reclaimed order and get its rent back. The order's history survives as an on-chain event, so nothing verifiable is lost. Worth doing for small payments, where the rent can otherwise exceed the payment itself.",
    inputSchema: {
      merchant: z.string().describe("The merchant's Solana address"),
      order_id: z.number().int().positive().describe("The order id to close"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ merchant, order_id }) => {
    try {
      const id = new BN(order_id);
      const payment = paymentPda(new PublicKey(merchant), id);
      const sig = await program.methods
        .closePayment(id)
        .accounts({ payment, buyer: wallet.publicKey })
        .signers([wallet])
        .rpc();
      return ok(
        [
          `Order ${order_id} closed and its rent returned.`,
          `  transaction          ${explorer("tx", sig)}`,
        ].join("\n")
      );
    } catch (e) {
      return fail(describeError(e));
    }
  }
);

async function main() {
  console.error(
    `x402-escrow MCP server — program ${program.programId.toBase58()} on ${redactRpc(rpcUrl)}, wallet ${wallet.publicKey.toBase58()}`
  );
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
