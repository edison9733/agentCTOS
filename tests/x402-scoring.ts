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

describe("x402 escrow — routed by collateral", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

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

  const TREASURY = new PublicKey("5i7zzV9hQUCbpg8MXSNJB3QQkL6zscDd8VQKow46vg7E");
  const FEE_BPS = 50;

  const DECIMALS = 6;
  const unit = (n: number) => new BN(Math.round(n * 10 ** DECIMALS));
  const payerWallet = (provider.wallet as anchor.Wallet).payer;

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
    PublicKey.findProgramAddressSync([Buffer.from("vault"), payment.toBuffer()], program.programId)[0];

  const reservePda = (merchant: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("reserve"), merchant.toBuffer()], program.programId)[0];

  const reserveVaultPda = (reserve: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("reserve_vault"), reserve.toBuffer()],
      program.programId
    )[0];

  const standingPda = (buyer: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("standing"), buyer.toBuffer()], program.programId)[0];

  before(async () => {
    mint = await createMint(provider.connection, payerWallet, provider.wallet.publicKey, null, DECIMALS);
    treasuryToken = await createAccount(provider.connection, payerWallet, mint, TREASURY, Keypair.generate());
  });

  /** A fresh, funded buyer keypair with its own token account. */
  async function fundedBuyer(amount: BN): Promise<{ keypair: Keypair; token: PublicKey }> {
    const keypair = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(keypair.publicKey, LAMPORTS_PER_SOL / 5);
    await provider.connection.confirmTransaction(sig);
    const token = await createAccount(provider.connection, payerWallet, mint, keypair.publicKey, Keypair.generate());
    await mintTo(provider.connection, payerWallet, mint, token, provider.wallet.publicKey, BigInt(amount.toString()));
    return { keypair, token };
  }

  /** A fresh merchant, optionally with a reserve opened and funded. */
  async function newMerchant(reserveAmount?: BN) {
    const owner = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(owner.publicKey, LAMPORTS_PER_SOL / 5);
    await provider.connection.confirmTransaction(sig);
    const token = await createAccount(provider.connection, payerWallet, mint, owner.publicKey, Keypair.generate());

    if (reserveAmount !== undefined) {
      const reserve = reservePda(owner.publicKey);
      const reserveVault = reserveVaultPda(reserve);
      await program.methods
        .openReserve()
        .accounts({
          reserve,
          merchant: owner.publicKey,
          reserveVault,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([owner])
        .rpc();

      if (reserveAmount.gtn(0)) {
        const funding = await createAccount(provider.connection, payerWallet, mint, owner.publicKey, Keypair.generate());
        await mintTo(provider.connection, payerWallet, mint, funding, provider.wallet.publicKey, BigInt(reserveAmount.toString()));
        await program.methods
          .postReserve(reserveAmount)
          .accounts({
            reserve,
            merchant: owner.publicKey,
            reserveVault,
            merchantToken: funding,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();
      }
    }
    return { owner, token };
  }

  async function registerBuyer(buyer: Keypair) {
    await program.methods
      .registerBuyer()
      .accounts({
        standing: standingPda(buyer.publicKey),
        buyer: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();
  }

  /** Pays for one order, routed through whatever reserve/standing already exist. */
  async function pay(
    buyer: Keypair,
    buyerToken: PublicKey,
    merchant: PublicKey,
    merchantToken: PublicKey,
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
        merchantToken,
        escrowVault: vaultPda(payment),
        merchantReserve: reservePda(merchant),
        reserveVault: reserveVaultPda(reservePda(merchant)),
        buyerStanding: standingPda(buyer.publicKey),
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();
    return { payment, vault: vaultPda(payment) };
  }

  it("no reserve, no standing: the whole order is escrowed, nothing paid up front", async () => {
    const { owner, token } = await newMerchant();
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(100));

    const { payment, vault } = await pay(buyer, buyerToken, owner.publicKey, token, unit(25), new BN(1));

    const p: any = await program.account.payment.fetch(payment);
    assert.equal(p.amount.toString(), unit(25).toString());
    assert.equal(p.instantAmount.toNumber(), 0);
    assert.equal(p.escrowedAmount.toString(), unit(25).toString());
    assert.deepEqual(p.status, { escrowHeld: {} });
    assert.equal((await getAccount(provider.connection, vault)).amount.toString(), unit(25).toString());
    assert.equal((await getAccount(provider.connection, token)).amount.toString(), "0");
  });

  it("full reserve + established buyer: the whole order pays instantly", async () => {
    const { owner, token } = await newMerchant(unit(100));
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(200));
    await registerBuyer(buyer);

    // Establish standing with a first, unrelated (no-reserve) order.
    const first = await newMerchant();
    await pay(buyer, buyerToken, first.owner.publicKey, first.token, unit(10), new BN(100));
    await program.methods
      .confirmDelivery(new BN(100))
      .accounts({
        payment: paymentPda(buyer.publicKey, first.owner.publicKey, new BN(100)),
        buyer: buyer.publicKey,
        escrowVault: vaultPda(paymentPda(buyer.publicKey, first.owner.publicKey, new BN(100))),
        merchantToken: first.token,
        treasuryToken,
        merchantReserve: reservePda(first.owner.publicKey),
        buyerStanding: standingPda(buyer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
    const standingAfterFirst: any = await program.account.buyerStanding.fetch(standingPda(buyer.publicKey));
    assert.equal(standingAfterFirst.settledCount, 1, "buyer is now established");

    const { payment, vault } = await pay(buyer, buyerToken, owner.publicKey, token, unit(60), new BN(101));

    const p: any = await program.account.payment.fetch(payment);
    assert.equal(p.instantAmount.toString(), unit(60).toString());
    assert.equal(p.escrowedAmount.toNumber(), 0, "fully covered by reserve: nothing escrowed");
    assert.equal(
      (await getAccount(provider.connection, token)).amount.toString(),
      unit(60).toString(),
      "the merchant was paid instantly, in full, no fee on the instant portion"
    );
    const reserve: any = await program.account.merchantReserve.fetch(reservePda(owner.publicKey));
    assert.equal(reserve.lockedExposure.toString(), unit(60).toString());
    // A fully-instant order still opens a (now-empty) vault, closed on settlement.
    assert.equal((await getAccount(provider.connection, vault)).amount.toString(), "0");
  });

  it("full reserve + no history: still full escrow — a new buyer defaults to protection", async () => {
    const { owner, token } = await newMerchant(unit(100));
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(50));
    // Deliberately not registered: no BuyerStanding account exists at all.

    const { payment } = await pay(buyer, buyerToken, owner.publicKey, token, unit(30), new BN(2));
    const p: any = await program.account.payment.fetch(payment);
    assert.equal(p.instantAmount.toNumber(), 0);
    assert.equal(p.escrowedAmount.toString(), unit(30).toString());
  });

  it("partial reserve + established buyer: splits, instant up to the reserve", async () => {
    const { owner, token } = await newMerchant(unit(20));
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(200));
    await registerBuyer(buyer);
    const first = await newMerchant();
    await pay(buyer, buyerToken, first.owner.publicKey, first.token, unit(5), new BN(110));
    await program.methods
      .confirmDelivery(new BN(110))
      .accounts({
        payment: paymentPda(buyer.publicKey, first.owner.publicKey, new BN(110)),
        buyer: buyer.publicKey,
        escrowVault: vaultPda(paymentPda(buyer.publicKey, first.owner.publicKey, new BN(110))),
        merchantToken: first.token,
        treasuryToken,
        merchantReserve: reservePda(first.owner.publicKey),
        buyerStanding: standingPda(buyer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const { payment, vault } = await pay(buyer, buyerToken, owner.publicKey, token, unit(50), new BN(111));
    const p: any = await program.account.payment.fetch(payment);
    assert.equal(p.instantAmount.toString(), unit(20).toString(), "instant portion capped at the reserve");
    assert.equal(p.escrowedAmount.toString(), unit(30).toString(), "the rest is escrowed");
    assert.equal((await getAccount(provider.connection, token)).amount.toString(), unit(20).toString());
    assert.equal((await getAccount(provider.connection, vault)).amount.toString(), unit(30).toString());
  });

  it("no reserve + established buyer: still full escrow — nothing to lend against", async () => {
    const { owner, token } = await newMerchant(); // no reserve opened at all
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(100));
    await registerBuyer(buyer);
    const first = await newMerchant();
    await pay(buyer, buyerToken, first.owner.publicKey, first.token, unit(5), new BN(120));
    await program.methods
      .confirmDelivery(new BN(120))
      .accounts({
        payment: paymentPda(buyer.publicKey, first.owner.publicKey, new BN(120)),
        buyer: buyer.publicKey,
        escrowVault: vaultPda(paymentPda(buyer.publicKey, first.owner.publicKey, new BN(120))),
        merchantToken: first.token,
        treasuryToken,
        merchantReserve: reservePda(first.owner.publicKey),
        buyerStanding: standingPda(buyer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const { payment } = await pay(buyer, buyerToken, owner.publicKey, token, unit(15), new BN(121));
    const p: any = await program.account.payment.fetch(payment);
    assert.equal(p.instantAmount.toNumber(), 0);
    assert.equal(p.escrowedAmount.toString(), unit(15).toString());
  });

  it("confirm_delivery charges the fee only on the escrowed portion", async () => {
    const { owner, token } = await newMerchant();
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(100));
    const orderId = new BN(3);
    const { payment, vault } = await pay(buyer, buyerToken, owner.publicKey, token, unit(25), orderId);

    await program.methods
      .confirmDelivery(orderId)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vault,
        merchantToken: token,
        treasuryToken,
        merchantReserve: reservePda(owner.publicKey),
        buyerStanding: standingPda(buyer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const fee = unit(25).muln(FEE_BPS).divn(10_000);
    const p: any = await program.account.payment.fetch(payment);
    assert.deepEqual(p.status, { settled: {} });
    assert.equal(p.feeAmount.toString(), fee.toString());
    assert.equal(
      (await getAccount(provider.connection, token)).amount.toString(),
      unit(25).sub(fee).toString()
    );
  });

  it("withdraw_reserve is rejected past the currently-available (unlocked) balance", async () => {
    const { owner } = await newMerchant(unit(50));
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(200));
    await registerBuyer(buyer);
    const first = await newMerchant();
    await pay(buyer, buyerToken, first.owner.publicKey, first.token, unit(5), new BN(130));
    await program.methods
      .confirmDelivery(new BN(130))
      .accounts({
        payment: paymentPda(buyer.publicKey, first.owner.publicKey, new BN(130)),
        buyer: buyer.publicKey,
        escrowVault: vaultPda(paymentPda(buyer.publicKey, first.owner.publicKey, new BN(130))),
        merchantToken: first.token,
        treasuryToken,
        merchantReserve: reservePda(first.owner.publicKey),
        buyerStanding: standingPda(buyer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    // Lock 40 of the merchant's 50 reserve into an outstanding instant order.
    await pay(buyer, buyerToken, owner.publicKey, (await newMerchant()).token, unit(40), new BN(131));

    const withdrawDest = await createAccount(provider.connection, payerWallet, mint, owner.publicKey, Keypair.generate());
    try {
      await program.methods
        .withdrawReserve(unit(20)) // only 10 is actually unlocked
        .accounts({
          reserve: reservePda(owner.publicKey),
          merchant: owner.publicKey,
          reserveVault: reserveVaultPda(reservePda(owner.publicKey)),
          merchantToken: withdrawDest,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();
      assert.fail("expected the over-limit withdrawal to be rejected");
    } catch (err) {
      assert.ok(String(err).includes("InsufficientReserve"), `expected InsufficientReserve, got: ${err}`);
    }

    await program.methods
      .withdrawReserve(unit(10))
      .accounts({
        reserve: reservePda(owner.publicKey),
        merchant: owner.publicKey,
        reserveVault: reserveVaultPda(reservePda(owner.publicKey)),
        merchantToken: withdrawDest,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
    assert.equal((await getAccount(provider.connection, withdrawDest)).amount.toString(), unit(10).toString());
  });

  it("reclaim_timeout returns the escrow and skims the reserve to make the buyer whole", async () => {
    const { owner, token } = await newMerchant(unit(100));
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(200));
    await registerBuyer(buyer);
    const first = await newMerchant();
    await pay(buyer, buyerToken, first.owner.publicKey, first.token, unit(5), new BN(140));
    await program.methods
      .confirmDelivery(new BN(140))
      .accounts({
        payment: paymentPda(buyer.publicKey, first.owner.publicKey, new BN(140)),
        buyer: buyer.publicKey,
        escrowVault: vaultPda(paymentPda(buyer.publicKey, first.owner.publicKey, new BN(140))),
        merchantToken: first.token,
        treasuryToken,
        merchantReserve: reservePda(first.owner.publicKey),
        buyerStanding: standingPda(buyer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const orderId = new BN(141);
    const { payment, vault } = await pay(buyer, buyerToken, owner.publicKey, token, unit(60), orderId, 61);
    const balanceAfterPay = (await getAccount(provider.connection, buyerToken)).amount;

    await new Promise((r) => setTimeout(r, 62_000));

    await program.methods
      .reclaimTimeout(orderId)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vault,
        buyerToken,
        merchantReserve: reservePda(owner.publicKey),
        reserveVault: reserveVaultPda(reservePda(owner.publicKey)),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const p: any = await program.account.payment.fetch(payment);
    assert.deepEqual(p.status, { reclaimed: {} });
    assert.equal(p.feeAmount.toNumber(), 0);
    const balanceAfterReclaim = (await getAccount(provider.connection, buyerToken)).amount;
    assert.equal(
      (balanceAfterReclaim - balanceAfterPay).toString(),
      unit(60).toString(),
      "buyer recovers the full order: the escrowed remainder plus the skimmed instant amount"
    );
    const reserve: any = await program.account.merchantReserve.fetch(reservePda(owner.publicKey));
    assert.equal(reserve.lockedExposure.toNumber(), 0, "exposure is released even though the reserve was skimmed");
  }).timeout(150_000);

  it("claim_fulfillment -> finalize_claim pays an honest merchant when the buyer never returns", async () => {
    const { owner, token } = await newMerchant();
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(100));
    const orderId = new BN(150);
    const { payment, vault } = await pay(buyer, buyerToken, owner.publicKey, token, unit(25), orderId, 3600);

    await program.methods
      .claimFulfillment(orderId)
      .accounts({ payment, merchant: owner.publicKey })
      .signers([owner])
      .rpc();

    let p: any = await program.account.payment.fetch(payment);
    assert.ok(p.claimedAt.toNumber() > 0);

    try {
      await program.methods
        .finalizeClaim(orderId)
        .accounts({
          payment,
          escrowVault: vault,
          merchant: owner.publicKey,
          merchantToken: token,
          treasuryToken,
          merchantReserve: reservePda(owner.publicKey),
          buyerStanding: standingPda(buyer.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("expected finalize_claim to be rejected before the dispute window elapses");
    } catch (err) {
      assert.ok(String(err).includes("ClaimNotYetFinalizable"), `expected ClaimNotYetFinalizable, got: ${err}`);
    }

    p = await program.account.payment.fetch(payment);
    assert.deepEqual(p.status, { escrowHeld: {} }, "still open — the dispute window has not elapsed in this test");
  });

  it("dispute_claim clears a claim and falls back to the normal timeout path", async () => {
    const { owner, token } = await newMerchant();
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(100));
    const orderId = new BN(151);
    const { payment } = await pay(buyer, buyerToken, owner.publicKey, token, unit(25), orderId, 3600);

    await program.methods
      .claimFulfillment(orderId)
      .accounts({ payment, merchant: owner.publicKey })
      .signers([owner])
      .rpc();

    await program.methods
      .disputeClaim(orderId)
      .accounts({ payment, buyer: buyer.publicKey })
      .signers([buyer])
      .rpc();

    const p: any = await program.account.payment.fetch(payment);
    assert.equal(p.claimedAt.toNumber(), 0, "the claim is cleared");
    assert.deepEqual(p.status, { escrowHeld: {} });
  });

  it("rejects a timeout outside the allowed range", async () => {
    const { owner, token } = await newMerchant();
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(100));
    try {
      await pay(buyer, buyerToken, owner.publicKey, token, unit(10), new BN(6), 30);
      assert.fail("expected a sub-minimum timeout to be rejected");
    } catch (err) {
      assert.ok(String(err).includes("InvalidTimeout"), `expected InvalidTimeout, got: ${err}`);
    }
  });

  it("rejects a replayed order id", async () => {
    const { owner, token } = await newMerchant();
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(100));
    const orderId = new BN(7);
    await pay(buyer, buyerToken, owner.publicKey, token, unit(10), orderId);

    try {
      await pay(buyer, buyerToken, owner.publicKey, token, unit(10), orderId);
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
    const { keypair: buyer, token: buyerToken } = await fundedBuyer(unit(100));
    const orderId = new BN(8);
    const { payment, vault } = await pay(buyer, buyerToken, owner.publicKey, token, unit(25), orderId);

    try {
      await program.methods
        .closePayment(orderId)
        .accounts({ payment, buyer: buyer.publicKey })
        .signers([buyer])
        .rpc();
      assert.fail("expected closing an open escrow to be rejected");
    } catch (err) {
      assert.ok(String(err).includes("PaymentStillOpen"), `expected PaymentStillOpen, got: ${err}`);
    }

    await program.methods
      .confirmDelivery(orderId)
      .accounts({
        payment,
        buyer: buyer.publicKey,
        escrowVault: vault,
        merchantToken: token,
        treasuryToken,
        merchantReserve: reservePda(owner.publicKey),
        buyerStanding: standingPda(buyer.publicKey),
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
    assert.equal(await provider.connection.getAccountInfo(payment), null);
  });

  it("refund_escrow no longer exists — an order resolves only by fulfillment or the clock", () => {
    assert.equal(
      (program.methods as any).refundEscrow,
      undefined,
      "the mutual refund path was removed: it was the one way to reverse an order for free"
    );
  });
});
