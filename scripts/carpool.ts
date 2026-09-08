/**
 * Off-chain matching for a pooled x402 payment, then one on-chain transaction.
 *
 *   npm run carpool
 *
 * This is the off-chain half of `initiate_pooled_payment`: several buyers
 * want the same thing, each with their own ceiling on what they're willing
 * to pay for their share. A real deployed version of this would run as a
 * small service — agents register interest over HTTP, it matches them, and
 * it relays an *unsigned* transaction out to each matched agent to sign
 * remotely with its own key, broadcasting only once every signature is
 * back. This script demonstrates the same matching and transaction shape
 * with locally-held demo keypairs standing in for those remote agents, so
 * the whole thing runs end to end in one process.
 *
 * The important property either way: nothing is submitted, and no funds
 * move, until every matched contributor has already signed for their exact
 * amount. If matching fails, this throws before building any transaction.
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

const TREASURY = new PublicKey("5i7zzV9hQUCbpg8MXSNJB3QQkL6zscDd8VQKow46vg7E");
const DECIMALS = 6;
const unit = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));
const fmt = (n: BN) => (n.toNumber() / 10 ** DECIMALS).toFixed(3);

function explorer(kind: "tx" | "address", id: string, rpcUrl: string): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  return rpcUrl.includes("devnet") ? `${base}?cluster=devnet` : base;
}

const step = (n: number, title: string) => console.log(`\n[${n}] ${title}`);
const kv = (label: string, value: string) => console.log(`      ${label.padEnd(24)} ${value}`);

/** One agent interested in joining the pool. */
interface Interest {
  label: string;
  keypair: Keypair;
  token: PublicKey;
  /** The most this agent will pay for its own share of the order. */
  ceiling: BN;
}

/** One agent matched into the pool, with its share of the real price. */
interface Matched {
  interest: Interest;
  share: BN;
}

/**
 * The off-chain matching step. Splits `totalPrice` evenly across every
 * registered `interest`, and only accepts the match if every single one of
 * them can actually cover an equal share within their own declared
 * ceiling — this is where "the buyer sets the price" is actually enforced,
 * before anything is signed. Real matching could be smarter (reallocating
 * a shortfall among agents with room on their ceiling); kept to an even
 * split here since the point is the on-chain shape, not the matching
 * algorithm.
 */
function matchPool(interests: Interest[], totalPrice: BN): Matched[] {
  if (interests.length === 0) {
    throw new Error("no interested agents to pool");
  }
  const share = totalPrice.divRound(new BN(interests.length));
  const shortfall = interests.filter((i) => i.ceiling.lt(share));
  if (shortfall.length > 0) {
    throw new Error(
      `matching failed: ${shortfall.map((i) => i.label).join(", ")} ` +
        `set a ceiling below the ${fmt(share)}-token equal share`
    );
  }
  return interests.map((interest) => ({ interest, share }));
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
  anchor.setProvider(provider);

  const program = loadProgram(provider);
  const rpcUrl = provider.connection.rpcEndpoint;
  const payer = (provider.wallet as anchor.Wallet).payer;

  console.log("=".repeat(72));
  console.log(" x402 CARPOOL — N buyers, one escrowed order");
  console.log("=".repeat(72));
  kv("network", rpcUrl);
  kv("program", program.programId.toBase58());

  // ------------------------------------------------------- demo setup
  step(1, "Minting a demo token, a merchant, and two interested agents");
  const mint = await createMint(provider.connection, payer, provider.wallet.publicKey, null, DECIMALS);
  const merchant = Keypair.generate().publicKey;
  const merchantToken = await createAccount(provider.connection, payer, mint, merchant, Keypair.generate());
  const treasuryToken = await createAccount(provider.connection, payer, mint, TREASURY, Keypair.generate());

  const priceOfTheThing = unit(100); // what the merchant actually charges

  async function newInterest(label: string, fund: number, ceiling: number): Promise<Interest> {
    const keypair = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(keypair.publicKey, 0.1e9);
    await provider.connection.confirmTransaction(sig);
    const token = await createAccount(provider.connection, payer, mint, keypair.publicKey, Keypair.generate());
    await mintTo(provider.connection, payer, mint, token, provider.wallet.publicKey, BigInt(unit(fund).toString()));
    return { label, keypair, token, ceiling: unit(ceiling) };
  }

  const interests = [
    await newInterest("agent-a", 60, 60), // willing to pay up to 60
    await newInterest("agent-b", 60, 60), // willing to pay up to 60
  ];
  kv("order price", `${fmt(priceOfTheThing)} tokens`);
  interests.forEach((i) => kv(`${i.label} ceiling`, `${fmt(i.ceiling)} tokens`));

  // ---------------------------------------------------------- matching
  step(2, "Off-chain matching: computing each agent's share, checking ceilings");
  const matched = matchPool(interests, priceOfTheThing);
  matched.forEach((m) => kv(`${m.interest.label} owes`, `${fmt(m.share)} tokens (cleared its ceiling)`));
  console.log(
    "      Every agent above already cleared its own ceiling before anyone was\n" +
      "      asked to sign — the on-chain transaction below has nothing left to\n" +
      "      negotiate, which is what lets it settle immediately."
  );

  // ---------------------------------------- one transaction, N signers
  step(3, "initiate_pooled_payment — one transaction, N signers, N shares");
  const orderId = new BN(Date.now() % 1_000_000_000);
  const coordinator = matched[0].interest.keypair; // any contributor can stand in as coordinator
  const payment = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pooled_payment"),
      coordinator.publicKey.toBuffer(),
      merchant.toBuffer(),
      orderId.toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  )[0];
  const vault = PublicKey.findProgramAddressSync(
    [Buffer.from("pooled_vault"), payment.toBuffer()],
    program.programId
  )[0];

  const remainingAccounts = matched.flatMap((m) => [
    { pubkey: m.interest.keypair.publicKey, isWritable: false, isSigner: true },
    { pubkey: m.interest.token, isWritable: true, isSigner: false },
  ]);

  // In a deployed matching service, this is the point where the built,
  // *unsigned* transaction would be sent out to each matched agent's own
  // remote signer and returned once signed — never a locally-held key the
  // service itself controls. Every keypair here is a stand-in for that.
  const paySig = await program.methods
    .initiatePooledPayment(orderId, new BN(3600), matched.map((m) => m.share))
    .accounts({
      payment,
      merchant,
      coordinator: coordinator.publicKey,
      escrowVault: vault,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .remainingAccounts(remainingAccounts)
    .signers(matched.map((m) => m.interest.keypair))
    .rpc();

  const p: any = await program.account.pooledPayment.fetch(payment);
  kv("order_id", orderId.toString());
  kv("payment", payment.toBase58());
  kv("total escrowed", `${fmt(p.amount)} tokens from ${p.contributorCount} contributors`);
  kv("tx", explorer("tx", paySig, rpcUrl));

  // -------------------------------------------------------- settlement
  step(4, "confirm_pooled_delivery — coordinator releases the escrow");
  const settleSig = await program.methods
    .confirmPooledDelivery(orderId)
    .accounts({
      payment,
      coordinator: coordinator.publicKey,
      escrowVault: vault,
      merchantToken,
      treasuryToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([coordinator])
    .rpc();

  kv("merchant received", fmt((await getAccount(provider.connection, merchantToken)).amount));
  kv("tx", explorer("tx", settleSig, rpcUrl));
}

main().catch((e) => {
  console.error("\nCarpool failed:", e);
  process.exit(1);
});
