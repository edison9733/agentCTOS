import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { X402Scoring } from "../target/types/x402_scoring";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

describe("x402 escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // anchor.workspace mis-derives the IDL filename for program names containing
  // digits (x_402_scoring.json), and anchor-cli 0.29 emits no address field in
  // the IDL, so both are read from disk instead.
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "x402_scoring.json"), "utf8")
  );
  const programId = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "..", "target", "deploy", "x402_scoring-keypair.json"),
          "utf8"
        )
      )
    )
  ).publicKey;
  const program = new anchor.Program(idl, programId, provider) as Program<X402Scoring>;

  // Must match TREASURY in programs/x402-scoring/src/lib.rs.
  const TREASURY = new PublicKey("5i7zzV9hQUCbpg8MXSNJB3QQkL6zscDd8VQKow46vg7E");
  const FEE_BPS = 50;

  const DECIMALS = 6;
  const unit = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));
  const payerWallet = (provider.wallet as anchor.Wallet).payer;

  const buyer = Keypair.generate();
  let mint: PublicKey;
  let treasuryToken: PublicKey;

  const paymentPda = (buyerKey: PublicKey, merchant: PublicKey, orderId: BN) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("payment"),
        buyerKey.toBuffer(),
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

  before(async () => {
    const sig = await provider.connection.requestAirdrop(buyer.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
    mint = await createMint(
      provider.connection,
      payerWallet,
      provider.wallet.publicKey,
      null,
      DECIMALS
    );
    // The treasury is a fixed address in the program, so this account is
    // created for it rather than by it — the test wallet only pays the rent.
    treasuryToken = await createAccount(
      provider.connection,
      payerWallet,
      mint,
      TREASURY,
      Keypair.generate()
    );
  });

  /** A funded buyer token account. Each call gets its own, so tests never
   *  collide on the single associated token account for (mint, buyer). */
  async function fundedBuyerToken(amount: BN): Promise<PublicKey> {
    const acct = await createAccount(
      provider.connection,
      payerWallet,
      mint,
      buyer.publicKey,
      Keypair.generate()
    );
    await mintTo(
      provider.connection,
      payerWallet,
      mint,
      acct,
      provider.wallet.publicKey,
      BigInt(amount.toString())
    );
    return acct;
  }

  async function newMerchant() {
    const owner = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(owner.publicKey, LAMPORTS_PER_SOL / 20);
    await provider.connection.confirmTransaction(sig);
    const token = await createAccount(
      provider.connection,
      payerWallet,
      mint,
      owner.publicKey,
      Keypair.generate()
    );
    return { owner, token };
  }

  async function pay(
    merchant: PublicKey,
    buyerToken: PublicKey,
    amount: BN,
    orderId: BN,
    timeoutSeconds = 3600
  ) {
    const payment = paymentPda(buyer.publicKey, merchant, orderId);
    await program.methods
      .initiatePayment(amount, orderId, new BN(timeoutSeconds))
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
    return { payment, vault: vaultPda(payment) };
  }

  it("escrows the whole payment — the merchant receives nothing up front", async () => {
    const { owner, token } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(100));

    const { payment, vault } = await pay(owner.publicKey, buyerToken, unit(25), new BN(1));

    const p = await program.account.payment.fetch(payment);
    assert.equal(p.amount.toString(), unit(25).toString());
    assert.deepEqual(p.status, { escrowHeld: {} });
    assert.equal(p.merchant.toBase58(), owner.publicKey.toBase58());
    assert.equal(p.mint.toBase58(), mint.toBase58());

    assert.equal((await getAccount(provider.connection, vault)).amount.toString(), unit(25).toString());
    assert.equal((await getAccount(provider.connection, token)).amount.toString(), "0");
    assert.equal(
      (await getAccount(provider.connection, buyerToken)).amount.toString(),
      unit(75).toString()
    );
  });

  it("confirm_delivery releases the escrow to the merchant", async () => {
    const { owner, token } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(100));
    const orderId = new BN(2);
    const { payment } = await pay(owner.publicKey, buyerToken, unit(25), orderId);

    await program.methods
      .confirmDelivery(orderId)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vaultPda(payment),
        merchantToken: token,
        treasuryToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const fee = unit(25).muln(FEE_BPS).divn(10_000);
    const p = await program.account.payment.fetch(payment);
    assert.deepEqual(p.status, { settled: {} });
    assert.equal(p.feeAmount.toString(), fee.toString());
    assert.equal(
      (await getAccount(provider.connection, token)).amount.toString(),
      unit(25).sub(fee).toString(),
      "the merchant receives the order minus the settlement fee"
    );
    assert.equal(
      (await getAccount(provider.connection, treasuryToken)).amount.toString(),
      fee.toString()
    );
  });

  it("refund_escrow returns the money in full when both parties sign", async () => {
    const { owner } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(100));
    const orderId = new BN(3);
    const { payment } = await pay(owner.publicKey, buyerToken, unit(25), orderId);

    await program.methods
      .refundEscrow(orderId)
      .accounts({
        payment,
        merchant: owner.publicKey,
        buyer: buyer.publicKey,
        escrowVault: vaultPda(payment),
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner, buyer])
      .rpc();

    const p = await program.account.payment.fetch(payment);
    assert.deepEqual(p.status, { refunded: {} });
    assert.equal(p.feeAmount.toNumber(), 0, "a refund must not charge a fee");
    assert.equal(
      (await getAccount(provider.connection, buyerToken)).amount.toString(),
      unit(100).toString()
    );
  });

  it("neither party can refund alone — a cancellation needs both", async () => {
    // A buyer alone could otherwise take delivery and pull the money back; a
    // merchant alone could cancel an order already paid for. Acting alone has
    // exactly one route, and it waits for the clock: reclaim_timeout.
    const { owner } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(100));
    const orderId = new BN(4);
    const { payment } = await pay(owner.publicKey, buyerToken, unit(25), orderId);

    try {
      await program.methods
        .refundEscrow(orderId)
        .accounts({
          payment,
          merchant: owner.publicKey,
          buyer: buyer.publicKey,
          escrowVault: vaultPda(payment),
          buyerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer]) // buyer signs; the merchant does not
        .rpc();
      assert.fail("expected the refund to be rejected without the merchant's signature");
    } catch (err) {
      assert.ok(
        /Signature verification failed|missing required signature|unknown signer/i.test(String(err)),
        `expected a missing-signature failure, got: ${err}`
      );
    }

    const p = await program.account.payment.fetch(payment);
    assert.deepEqual(p.status, { escrowHeld: {} });
  });

  it("reclaim is rejected before the escrow expires", async () => {
    const { owner } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(100));
    const orderId = new BN(5);
    const { payment } = await pay(owner.publicKey, buyerToken, unit(25), orderId);

    try {
      await program.methods
        .reclaimTimeout(orderId)
        .accounts({
          payment,
          buyer: buyer.publicKey,
          escrowVault: vaultPda(payment),
          buyerToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();
      assert.fail("expected reclaim before expiry to be rejected");
    } catch (err) {
      assert.ok(
        String(err).includes("ReclaimNotYetAvailable"),
        `expected ReclaimNotYetAvailable, got: ${err}`
      );
    }
  });

  it("rejects a timeout outside the allowed range", async () => {
    const { owner } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(100));
    try {
      await pay(owner.publicKey, buyerToken, unit(10), new BN(6), 30);
      assert.fail("expected a sub-minimum timeout to be rejected");
    } catch (err) {
      assert.ok(String(err).includes("InvalidTimeout"), `expected InvalidTimeout, got: ${err}`);
    }
  });

  it("rejects a replayed order id", async () => {
    const { owner } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(100));
    const orderId = new BN(7);
    await pay(owner.publicKey, buyerToken, unit(10), orderId);

    try {
      await pay(owner.publicKey, buyerToken, unit(10), orderId);
      assert.fail("expected the duplicate order id to be rejected");
    } catch (err) {
      assert.ok(
        /already in use|custom program error: 0x0/i.test(String(err)),
        `expected an account-already-exists failure, got: ${err}`
      );
    }
  });

  it("close_payment refunds rent once an order is finished, but not before", async () => {
    const { owner, token } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(100));
    const orderId = new BN(8);
    const { payment } = await pay(owner.publicKey, buyerToken, unit(25), orderId);

    try {
      await program.methods
        .closePayment(orderId)
        .accounts({ payment, buyer: buyer.publicKey })
        .signers([buyer])
        .rpc();
      assert.fail("expected closing an open escrow to be rejected");
    } catch (err) {
      assert.ok(
        String(err).includes("PaymentStillOpen"),
        `expected PaymentStillOpen, got: ${err}`
      );
    }

    await program.methods
      .confirmDelivery(orderId)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vaultPda(payment),
        merchantToken: token,
        treasuryToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const before = await provider.connection.getBalance(buyer.publicKey);
    await program.methods
      .closePayment(orderId)
      .accounts({ payment, buyer: buyer.publicKey })
      .signers([buyer])
      .rpc();

    assert.ok(
      (await provider.connection.getBalance(buyer.publicKey)) > before,
      "closing the payment should have returned its rent to the buyer"
    );
    assert.equal(
      await provider.connection.getAccountInfo(payment),
      null,
      "the payment account should no longer exist"
    );
  });

  it("after the timeout the buyer recovers the escrow alone", async () => {
    const { owner, token } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(100));
    const orderId = new BN(9);
    // 61s is the shortest the program allows; the wait below is real.
    const { payment } = await pay(owner.publicKey, buyerToken, unit(40), orderId, 61);

    await new Promise((r) => setTimeout(r, 62_000));

    await program.methods
      .reclaimTimeout(orderId)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vaultPda(payment),
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer]) // the merchant is not a signer here, and cannot block it
      .rpc();

    const p = await program.account.payment.fetch(payment);
    assert.deepEqual(p.status, { reclaimed: {} });
    assert.equal(p.feeAmount.toNumber(), 0, "a reclaimed order must not charge a fee");
    assert.equal(
      (await getAccount(provider.connection, buyerToken)).amount.toString(),
      unit(100).toString()
    );
    assert.equal((await getAccount(provider.connection, token)).amount.toString(), "0");
    // The vault is closed once emptied.
    assert.equal(await provider.connection.getAccountInfo(vaultPda(payment)), null);
  }).timeout(150_000);
});
