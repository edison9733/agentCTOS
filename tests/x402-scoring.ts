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

  const pooledPaymentPda = (coordinator: PublicKey, merchant: PublicKey, orderId: BN) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("pooled_payment"),
        coordinator.toBuffer(),
        merchant.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

  const pooledVaultPda = (payment: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("pooled_vault"), payment.toBuffer()],
      program.programId
    )[0];

  /** A funded contributor: a fresh keypair with SOL for rent, and a token
   *  account holding exactly `amount`. */
  async function fundedContributor(amount: BN): Promise<{ keypair: Keypair; token: PublicKey }> {
    const keypair = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(keypair.publicKey, LAMPORTS_PER_SOL / 10);
    await provider.connection.confirmTransaction(sig);
    const token = await createAccount(
      provider.connection,
      payerWallet,
      mint,
      keypair.publicKey,
      Keypair.generate()
    );
    await mintTo(provider.connection, payerWallet, mint, token, provider.wallet.publicKey, BigInt(amount.toString()));
    return { keypair, token };
  }

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

  it("batch_confirm_delivery settles multiple orders in one transaction", async () => {
    const { owner: owner1, token: token1 } = await newMerchant();
    const { owner: owner2, token: token2 } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(200));

    const orderId1 = new BN(10);
    const orderId2 = new BN(11);
    const { payment: payment1, vault: vault1 } = await pay(
      owner1.publicKey,
      buyerToken,
      unit(30),
      orderId1
    );
    const { payment: payment2, vault: vault2 } = await pay(
      owner2.publicKey,
      buyerToken,
      unit(50),
      orderId2
    );

    const treasuryBefore = (await getAccount(provider.connection, treasuryToken)).amount;

    await program.methods
      .batchConfirmDelivery()
      .accounts({
        buyer: buyer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: payment1, isWritable: true, isSigner: false },
        { pubkey: vault1, isWritable: true, isSigner: false },
        { pubkey: token1, isWritable: true, isSigner: false },
        { pubkey: treasuryToken, isWritable: true, isSigner: false },
        { pubkey: payment2, isWritable: true, isSigner: false },
        { pubkey: vault2, isWritable: true, isSigner: false },
        { pubkey: token2, isWritable: true, isSigner: false },
        { pubkey: treasuryToken, isWritable: true, isSigner: false },
      ])
      .signers([buyer])
      .rpc();

    const fee1 = unit(30).muln(FEE_BPS).divn(10_000);
    const fee2 = unit(50).muln(FEE_BPS).divn(10_000);

    const p1 = await program.account.payment.fetch(payment1);
    const p2 = await program.account.payment.fetch(payment2);
    assert.deepEqual(p1.status, { settled: {} });
    assert.deepEqual(p2.status, { settled: {} });
    assert.equal(p1.feeAmount.toString(), fee1.toString());
    assert.equal(p2.feeAmount.toString(), fee2.toString());

    assert.equal(
      (await getAccount(provider.connection, token1)).amount.toString(),
      unit(30).sub(fee1).toString(),
      "merchant 1 receives their order minus its fee"
    );
    assert.equal(
      (await getAccount(provider.connection, token2)).amount.toString(),
      unit(50).sub(fee2).toString(),
      "merchant 2 receives their order minus its fee"
    );

    const treasuryAfter = (await getAccount(provider.connection, treasuryToken)).amount;
    assert.equal(
      (treasuryAfter - treasuryBefore).toString(),
      fee1.add(fee2).toString(),
      "the treasury collects both orders' fees from the one batched transaction"
    );

    // Both vaults close once emptied, exactly as a single confirm_delivery would.
    assert.equal(await provider.connection.getAccountInfo(vault1), null);
    assert.equal(await provider.connection.getAccountInfo(vault2), null);
  });

  it("rejects a batch whose account count is not a multiple of 4", async () => {
    const { owner, token } = await newMerchant();
    const buyerToken = await fundedBuyerToken(unit(100));
    const orderId = new BN(12);
    const { payment, vault } = await pay(owner.publicKey, buyerToken, unit(20), orderId);

    try {
      await program.methods
        .batchConfirmDelivery()
        .accounts({
          buyer: buyer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: payment, isWritable: true, isSigner: false },
          { pubkey: vault, isWritable: true, isSigner: false },
          { pubkey: token, isWritable: true, isSigner: false },
          // treasuryToken deliberately omitted: 3 accounts, not a multiple of 4.
        ])
        .signers([buyer])
        .rpc();
      assert.fail("expected a non-multiple-of-4 batch to be rejected");
    } catch (err) {
      assert.ok(
        String(err).includes("InvalidBatchSize"),
        `expected InvalidBatchSize, got: ${err}`
      );
    }
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

  it("initiate_pooled_payment merges two buyers into one escrowed order", async () => {
    const { owner, token } = await newMerchant();
    const a = await fundedContributor(unit(30));
    const b = await fundedContributor(unit(70));

    const orderId = new BN(20);
    const payment = pooledPaymentPda(a.keypair.publicKey, owner.publicKey, orderId);
    const vault = pooledVaultPda(payment);

    await program.methods
      .initiatePooledPayment(orderId, new BN(3600), [unit(30), unit(70)])
      .accounts({
        payment,
        merchant: owner.publicKey,
        coordinator: a.keypair.publicKey,
        escrowVault: vault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: a.keypair.publicKey, isWritable: false, isSigner: true },
        { pubkey: a.token, isWritable: true, isSigner: false },
        { pubkey: b.keypair.publicKey, isWritable: false, isSigner: true },
        { pubkey: b.token, isWritable: true, isSigner: false },
      ])
      .signers([a.keypair, b.keypair])
      .rpc();

    const p: any = await program.account.pooledPayment.fetch(payment);
    assert.equal(p.amount.toString(), unit(100).toString());
    assert.equal(p.contributorCount, 2);
    assert.equal(p.coordinator.toBase58(), a.keypair.publicKey.toBase58());
    assert.equal((await getAccount(provider.connection, vault)).amount.toString(), unit(100).toString());
    assert.equal((await getAccount(provider.connection, a.token)).amount.toString(), "0");
    assert.equal((await getAccount(provider.connection, b.token)).amount.toString(), "0");

    const treasuryBefore = (await getAccount(provider.connection, treasuryToken)).amount;
    await program.methods
      .confirmPooledDelivery(orderId)
      .accounts({
        payment,
        coordinator: a.keypair.publicKey,
        escrowVault: vault,
        merchantToken: token,
        treasuryToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([a.keypair])
      .rpc();

    const fee = unit(100).muln(FEE_BPS).divn(10_000);
    const p2: any = await program.account.pooledPayment.fetch(payment);
    assert.deepEqual(p2.status, { settled: {} });
    assert.equal(
      (await getAccount(provider.connection, token)).amount.toString(),
      unit(100).sub(fee).toString(),
      "the merchant receives the pooled order minus the settlement fee"
    );
    assert.equal(
      ((await getAccount(provider.connection, treasuryToken)).amount - treasuryBefore).toString(),
      fee.toString()
    );
    assert.equal(await provider.connection.getAccountInfo(vault), null);
  });

  it("reclaim_pooled_timeout refunds each contributor their own amount, with no signer required", async () => {
    const { owner } = await newMerchant();
    const a = await fundedContributor(unit(15));
    const b = await fundedContributor(unit(25));

    const orderId = new BN(21);
    const payment = pooledPaymentPda(a.keypair.publicKey, owner.publicKey, orderId);
    const vault = pooledVaultPda(payment);

    // 61s is the shortest timeout the program allows; the wait below is real.
    await program.methods
      .initiatePooledPayment(orderId, new BN(61), [unit(15), unit(25)])
      .accounts({
        payment,
        merchant: owner.publicKey,
        coordinator: a.keypair.publicKey,
        escrowVault: vault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: a.keypair.publicKey, isWritable: false, isSigner: true },
        { pubkey: a.token, isWritable: true, isSigner: false },
        { pubkey: b.keypair.publicKey, isWritable: false, isSigner: true },
        { pubkey: b.token, isWritable: true, isSigner: false },
      ])
      .signers([a.keypair, b.keypair])
      .rpc();

    await new Promise((r) => setTimeout(r, 62_000));

    // No .signers() at all — reclaim_pooled_timeout takes no signer, only
    // the clock, and the default provider wallet pays for this transaction
    // despite not being a contributor itself.
    await program.methods
      .reclaimPooledTimeout(orderId)
      .accounts({
        payment,
        coordinator: a.keypair.publicKey,
        escrowVault: vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: a.token, isWritable: true, isSigner: false },
        { pubkey: b.token, isWritable: true, isSigner: false },
      ])
      .rpc();

    const p: any = await program.account.pooledPayment.fetch(payment);
    assert.deepEqual(p.status, { reclaimed: {} });
    assert.equal(p.feeAmount.toNumber(), 0, "a reclaimed pooled order must not charge a fee");
    assert.equal(
      (await getAccount(provider.connection, a.token)).amount.toString(),
      unit(15).toString(),
      "contributor A gets back exactly their own contribution"
    );
    assert.equal(
      (await getAccount(provider.connection, b.token)).amount.toString(),
      unit(25).toString(),
      "contributor B gets back exactly their own contribution"
    );
    assert.equal(await provider.connection.getAccountInfo(vault), null);
  }).timeout(150_000);
});
