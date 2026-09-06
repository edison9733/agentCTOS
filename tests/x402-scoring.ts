import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { X402Scoring } from "../target/types/x402_scoring";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import * as assert from "assert";

describe("x402-scoring", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.X402Scoring as Program<X402Scoring>;

  let mint: PublicKey;
  let buyerTokenAccount: PublicKey;
  let merchantTokenAccount: PublicKey;
  let escrowTokenAccount: PublicKey;

  const buyer = Keypair.generate();
  const merchant = Keypair.generate();
  const escrowAuthority = Keypair.generate();

  before(async () => {
    // Airdrop SOL to accounts
    const airdropSig = await provider.connection.requestAirdrop(
      buyer.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Create mint
    mint = await createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      6
    );

    // Create token accounts
    buyerTokenAccount = await createAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      buyer.publicKey
    );

    merchantTokenAccount = await createAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      merchant.publicKey
    );

    escrowTokenAccount = await createAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      escrowAuthority.publicKey
    );

    // Mint tokens to buyer
    await mintTo(
      provider.connection,
      provider.wallet.payer,
      mint,
      buyerTokenAccount,
      provider.wallet.publicKey,
      1_000_000
    );
  });

  it("Registers a merchant with Low tier", async () => {
    const [merchantAccount, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("merchant"), merchant.publicKey.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .registerMerchant(bump)
      .accounts({
        merchant: merchantAccount,
        owner: merchant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([merchant])
      .rpc();

    const merchantData = await program.account.merchant.fetch(merchantAccount);
    assert.equal(merchantData.address.toString(), merchant.publicKey.toString());
    assert.equal(merchantData.tier.low, {});
    assert.equal(merchantData.totalPayments, 0);
    assert.equal(merchantData.successfulDeliveries, 0);
  });

  it("Updates merchant tier to High", async () => {
    const [merchantAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("merchant"), merchant.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .updateMerchantTier(1)
      .accounts({
        merchant: merchantAccount,
        owner: merchant.publicKey,
      })
      .signers([merchant])
      .rpc();

    const merchantData = await program.account.merchant.fetch(merchantAccount);
    assert.equal(merchantData.tier.high, {});
  });

  it("Processes instant payment for High-tier merchant", async () => {
    const [merchantAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("merchant"), merchant.publicKey.toBuffer()],
      program.programId
    );

    const orderId = new anchor.BN(1);
    const amount = new anchor.BN(100_000);

    const [paymentAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("payment"),
        buyer.publicKey.toBuffer(),
        merchantAccount.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .initiatePayment(amount, orderId)
      .accounts({
        payment: paymentAccount,
        merchant: merchantAccount,
        buyer: buyer.publicKey,
        buyerToken: buyerTokenAccount,
        merchantToken: merchantTokenAccount,
        escrowToken: escrowTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const paymentData = await program.account.payment.fetch(paymentAccount);
    assert.equal(paymentData.status.settled, {});
  });

  it("Processes escrow payment for Low-tier merchant", async () => {
    // Register a new low-tier merchant
    const lowTierMerchant = Keypair.generate();
    const [lowMerchantAccount, lowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("merchant"), lowTierMerchant.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerMerchant(lowBump)
      .accounts({
        merchant: lowMerchantAccount,
        owner: lowTierMerchant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lowTierMerchant])
      .rpc();

    // Create token account for low-tier merchant
    const lowMerchantTokenAccount = await createAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      lowTierMerchant.publicKey
    );

    const orderId = new anchor.BN(2);
    const amount = new anchor.BN(100_000);

    const [paymentAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("payment"),
        buyer.publicKey.toBuffer(),
        lowMerchantAccount.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .initiatePayment(amount, orderId)
      .accounts({
        payment: paymentAccount,
        merchant: lowMerchantAccount,
        buyer: buyer.publicKey,
        buyerToken: buyerTokenAccount,
        merchantToken: lowMerchantTokenAccount,
        escrowToken: escrowTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const paymentData = await program.account.payment.fetch(paymentAccount);
    assert.equal(paymentData.status.escrowHeld, {});
  });

  it("Confirms delivery and releases escrow", async () => {
    const lowTierMerchant = Keypair.generate();
    const [lowMerchantAccount, lowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("merchant"), lowTierMerchant.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerMerchant(lowBump)
      .accounts({
        merchant: lowMerchantAccount,
        owner: lowTierMerchant.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lowTierMerchant])
      .rpc();

    const lowMerchantTokenAccount = await createAccount(
      provider.connection,
      provider.wallet.payer,
      mint,
      lowTierMerchant.publicKey
    );

    const orderId = new anchor.BN(3);
    const amount = new anchor.BN(100_000);

    const [paymentAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("payment"),
        buyer.publicKey.toBuffer(),
        lowMerchantAccount.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Initiate payment to escrow
    await program.methods
      .initiatePayment(amount, orderId)
      .accounts({
        payment: paymentAccount,
        merchant: lowMerchantAccount,
        buyer: buyer.publicKey,
        buyerToken: buyerTokenAccount,
        merchantToken: lowMerchantTokenAccount,
        escrowToken: escrowTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    // Confirm delivery
    await program.methods
      .confirmDelivery(orderId)
      .accounts({
        payment: paymentAccount,
        merchant: lowMerchantAccount,
        buyer: buyer.publicKey,
        escrowToken: escrowTokenAccount,
        merchantToken: lowMerchantTokenAccount,
        escrowAuthority: escrowAuthority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([buyer, escrowAuthority])
      .rpc();

    const paymentData = await program.account.payment.fetch(paymentAccount);
    assert.equal(paymentData.status.settled, {});
  });
});
