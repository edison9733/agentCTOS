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

describe("x402-scoring (Agent CTOS anti-rug escrow)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.X402Scoring as Program<X402Scoring>;
  const payerWallet = (provider.wallet as anchor.Wallet).payer;

  let mint: PublicKey;
  const DECIMALS = 6;
  const unit = (n: number) => new BN(n * 10 ** DECIMALS);

  const buyer = Keypair.generate();

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

  async function registerMerchant(): Promise<{ owner: Keypair; merchant: PublicKey; token: PublicKey }> {
    const owner = Keypair.generate();
    const merchant = merchantPda(owner.publicKey);

    await program.methods
      .registerMerchant()
      .accounts({
        merchant,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const token = await createAccount(
      provider.connection,
      payerWallet,
      mint,
      owner.publicKey
    );

    return { owner, merchant, token };
  }

  async function pay(
    merchant: PublicKey,
    merchantToken: PublicKey,
    buyerToken: PublicKey,
    amount: BN,
    orderId: BN,
    timeoutSeconds = 3600
  ) {
    const payment = paymentPda(merchant, orderId);
    const vault = vaultPda(payment);

    await program.methods
      .initiatePayment(amount, orderId, new BN(timeoutSeconds))
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        buyerToken,
        merchantToken,
        escrowVault: vault,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([buyer])
      .rpc();

    return { payment, vault };
  }

  before(async () => {
    const airdropSig = await provider.connection.requestAirdrop(
      buyer.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    mint = await createMint(
      provider.connection,
      payerWallet,
      provider.wallet.publicKey,
      null,
      DECIMALS
    );
  });

  async function fundBuyerToken(amount: BN): Promise<PublicKey> {
    const buyerToken = await createAccount(
      provider.connection,
      payerWallet,
      mint,
      buyer.publicKey
    );
    await mintTo(
      provider.connection,
      payerWallet,
      mint,
      buyerToken,
      provider.wallet.publicKey,
      BigInt(amount.toString())
    );
    return buyerToken;
  }

  it("Rule 4: a brand-new merchant starts at tier 1 with zero history", async () => {
    const { merchant } = await registerMerchant();
    const data = await program.account.merchant.fetch(merchant);
    assert.equal(data.tier, 1);
    assert.equal(data.completedTxCount.toNumber(), 0);
    assert.equal(data.avgTxSize.toNumber(), 0);
  });

  it("Rule 4/9: a new merchant's first payment is 100% escrowed, not sent instantly", async () => {
    const { merchant, token } = await registerMerchant();
    const buyerToken = await fundBuyerToken(unit(100));

    const { payment, vault } = await pay(merchant, token, buyerToken, unit(10), new BN(1));

    const paymentData = await program.account.payment.fetch(payment);
    assert.equal(paymentData.escrowAmount.toString(), unit(10).toString());
    assert.equal(paymentData.instantAmount.toNumber(), 0);
    assert.deepEqual(paymentData.status, { escrowHeld: {} });

    const vaultAccount = await getAccount(provider.connection, vault);
    assert.equal(vaultAccount.amount.toString(), unit(10).toString());

    const merchantTokenBefore = await getAccount(provider.connection, token);
    assert.equal(merchantTokenBefore.amount.toString(), "0");
  });

  it("Rule 7/8: confirming delivery releases escrow and only then updates tier history", async () => {
    const { merchant, token } = await registerMerchant();
    const buyerToken = await fundBuyerToken(unit(100));

    const { payment } = await pay(merchant, token, buyerToken, unit(10), new BN(1));

    await program.methods
      .confirmDelivery(new BN(1))
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        escrowVault: vaultPda(payment),
        merchantToken: token,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const merchantToken = await getAccount(provider.connection, token);
    assert.equal(merchantToken.amount.toString(), unit(10).toString());

    const merchantData = await program.account.merchant.fetch(merchant);
    assert.equal(merchantData.completedTxCount.toNumber(), 1);
    assert.equal(merchantData.avgTxSize.toString(), unit(10).toString());

    const paymentData = await program.account.payment.fetch(payment);
    assert.deepEqual(paymentData.status, { settled: {} });
  });

  it("Tier promotion is purely mechanical: 5 clean deliveries lift a merchant to tier 2", async () => {
    const { owner, merchant, token } = await registerMerchant();
    const buyerToken = await fundBuyerToken(unit(1000));

    for (let i = 1; i <= 5; i++) {
      const orderId = new BN(i);
      const { payment } = await pay(merchant, token, buyerToken, unit(10), orderId);
      await program.methods
        .confirmDelivery(orderId)
        .accounts({
          payment,
          merchant,
          buyer: buyer.publicKey,
          escrowVault: vaultPda(payment),
          merchantToken: token,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();
    }

    const merchantData = await program.account.merchant.fetch(merchant);
    assert.equal(merchantData.tier, 2);
    assert.equal(merchantData.completedTxCount.toNumber(), 5);
  });

  it("Rule 1/2: a tier-2 merchant's in-range payment gets a small scaled reserve, mostly instant", async () => {
    const { merchant, token } = await registerMerchant();
    const buyerToken = await fundBuyerToken(unit(1000));

    for (let i = 1; i <= 5; i++) {
      const orderId = new BN(i);
      const { payment } = await pay(merchant, token, buyerToken, unit(10), orderId);
      await program.methods
        .confirmDelivery(orderId)
        .accounts({
          payment,
          merchant,
          buyer: buyer.publicKey,
          escrowVault: vaultPda(payment),
          merchantToken: token,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();
    }

    // Merchant is now tier 2 with avg_tx_size = 10. Tier-2 multiplier is 10x,
    // so a 20-unit payment (2x avg) is well within bounds and should mostly settle instantly.
    const orderId = new BN(6);
    const amount = unit(20);
    const { payment } = await pay(merchant, token, buyerToken, amount, orderId);

    const paymentData = await program.account.payment.fetch(payment);
    assert.deepEqual(paymentData.status, { escrowHeld: {} });
    assert.ok(paymentData.escrowAmount.lt(amount), "only a slice should be escrowed, not the full amount");
    assert.ok(paymentData.instantAmount.gt(new BN(0)), "the rest should settle instantly");
    assert.equal(paymentData.forcedFullEscrow, false);
  });

  it("Rule 2/3/10: a payment far above historical average is forced into full escrow", async () => {
    const { merchant, token } = await registerMerchant();
    const buyerToken = await fundBuyerToken(unit(10_000));

    // Build a tier-2 history of $1 orders.
    for (let i = 1; i <= 5; i++) {
      const orderId = new BN(i);
      const { payment } = await pay(merchant, token, buyerToken, unit(1), orderId);
      await program.methods
        .confirmDelivery(orderId)
        .accounts({
          payment,
          merchant,
          buyer: buyer.publicKey,
          escrowVault: vaultPda(payment),
          merchantToken: token,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();
    }

    const merchantBefore = await program.account.merchant.fetch(merchant);
    assert.equal(merchantBefore.tier, 2); // 10x multiplier => max allowed is $10

    // A sudden $1000 bid after a $1 history: forced to escrow regardless of tier.
    const orderId = new BN(6);
    const amount = unit(1000);
    const { payment } = await pay(merchant, token, buyerToken, amount, orderId);

    const paymentData = await program.account.payment.fetch(payment);
    assert.equal(paymentData.forcedFullEscrow, true);
    assert.equal(paymentData.escrowAmount.toString(), amount.toString());
    assert.equal(paymentData.instantAmount.toNumber(), 0);

    // The merchant's tier itself is untouched by a size anomaly (only this tx is affected).
    const merchantAfter = await program.account.merchant.fetch(merchant);
    assert.equal(merchantAfter.tier, 2);
  });

  it("Rule 5/6/12: a reclaimed (timed-out) escrow demotes tier 2 back to tier 1 with a cold-start floor", async () => {
    const { merchant, token } = await registerMerchant();
    const buyerToken = await fundBuyerToken(unit(1000));

    for (let i = 1; i <= 5; i++) {
      const orderId = new BN(i);
      const { payment } = await pay(merchant, token, buyerToken, unit(10), orderId);
      await program.methods
        .confirmDelivery(orderId)
        .accounts({
          payment,
          merchant,
          buyer: buyer.publicKey,
          escrowVault: vaultPda(payment),
          merchantToken: token,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();
    }

    const merchantBefore = await program.account.merchant.fetch(merchant);
    assert.equal(merchantBefore.tier, 2);

    // Short-timeout order that the merchant never delivers on.
    const orderId = new BN(6);
    const { payment } = await pay(merchant, token, buyerToken, unit(15), orderId, 61);

    await new Promise((resolve) => setTimeout(resolve, 62_000));

    await program.methods
      .reclaimTimeout(orderId)
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        escrowVault: vaultPda(payment),
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const merchantAfter = await program.account.merchant.fetch(merchant);
    assert.equal(merchantAfter.tier, 1);
    assert.equal(
      merchantAfter.tierFloorTxCount.toNumber(),
      merchantAfter.completedTxCount.toNumber() + 10
    );

    const paymentData = await program.account.payment.fetch(payment);
    assert.deepEqual(paymentData.status, { reclaimed: {} });
  }).timeout(70_000);

  it("Rule 5: a buyer-initiated refund raises the refund rate for future tier math", async () => {
    const { merchant, token } = await registerMerchant();
    const buyerToken = await fundBuyerToken(unit(1000));

    const orderId = new BN(1);
    const { payment } = await pay(merchant, token, buyerToken, unit(10), orderId);

    await program.methods
      .refundEscrow(orderId)
      .accounts({
        payment,
        merchant,
        buyer: buyer.publicKey,
        escrowVault: vaultPda(payment),
        buyerToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();

    const paymentData = await program.account.payment.fetch(payment);
    assert.deepEqual(paymentData.status, { refunded: {} });

    const merchantData = await program.account.merchant.fetch(merchant);
    assert.equal(merchantData.refundCount.toNumber(), 1);
    assert.equal(merchantData.totalSettlementEvents.toNumber(), 1);
  });
});
