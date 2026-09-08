use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4");

// ---------------------------------------------------------------------------
// Agent CTOS — x402 Escrow
//
// x402's `exact` scheme on Solana is a single irreversible transfer: the buyer
// signs, the facilitator submits, and the money is gone the moment the
// transaction lands. If the merchant never delivers, the buyer has no recourse.
//
// This program replaces that transfer with an escrow. Every payment is held in
// full until one of three things happens:
//
//   confirm_delivery  buyer signs                -> the merchant is paid
//   refund_escrow     buyer AND merchant sign     -> the buyer is repaid
//   reclaim_timeout   buyer signs, after expiry   -> the buyer takes it back
//
// The design rule behind those three: an *instant* reversal needs both parties
// to agree, and anything one party can do alone must wait for the clock. That
// is what stops either side rugging the other — a buyer cannot take delivery
// and then pull the money back, and a merchant cannot keep money the buyer
// never confirmed.
//
// The vault holding the tokens is owned by the Payment account itself, not by
// any keypair. There is no operator, no admin, and no key anywhere in this
// program that can move a buyer's funds. Releases are signed by the Payment
// PDA's own seeds.
// ---------------------------------------------------------------------------

/// The protocol fee, in basis points of the order amount, charged only when an
/// order settles successfully. A percentage rather than a flat amount, so it
/// stays proportionate on a $0.001 API call and on a $10,000 order alike — a
/// flat fee would price micropayments, x402's main use case, out entirely.
///
/// Refunds and reclaims are free: a buyer who did not get what they paid for
/// pays nothing, and the protocol only earns when commerce actually works.
const FEE_BPS: u64 = 50; // 0.50%

/// Where settlement fees are sent. Compiled in rather than stored in a config
/// account on purpose: there is no admin instruction that can redirect it, and
/// changing it requires a program upgrade that anyone can see on-chain.
pub const TREASURY: Pubkey = pubkey!("5i7zzV9hQUCbpg8MXSNJB3QQkL6zscDd8VQKow46vg7E");

/// Bounds on how long an escrow may run before the buyer can reclaim it.
/// The floor stops a buyer from setting a deadline no merchant could meet;
/// the ceiling stops funds being locked indefinitely.
const MIN_TIMEOUT_SECONDS: i64 = 60;
const MAX_TIMEOUT_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

/// `batch_confirm_delivery` reads its orders from `remaining_accounts` in
/// groups of this many: `[payment, escrow_vault, merchant_token,
/// treasury_token]`, in that order.
const ACCOUNTS_PER_BATCH_ORDER: usize = 4;

/// Caps a batch well inside Solana's legacy transaction account limit
/// (~35 accounts). At 4 accounts/order plus the buyer and token_program
/// shared across the whole batch, 8 orders comfortably fits one transaction;
/// a client wanting more needs an Address Lookup Table.
const MAX_BATCH_SIZE: usize = 8;

#[program]
pub mod x402_scoring {
    use super::*;

    /// Takes payment for one order and holds the whole amount in escrow.
    ///
    /// The merchant receives nothing at this point. `order_id` is chosen by the
    /// caller and, together with the buyer and merchant, forms the Payment
    /// account's address — so replaying the same order id is rejected by the
    /// runtime rather than by a check here.
    pub fn initiate_payment(
        ctx: Context<InitiatePayment>,
        amount: u64,
        order_id: u64,
        timeout_seconds: i64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(
            (MIN_TIMEOUT_SECONDS..=MAX_TIMEOUT_SECONDS).contains(&timeout_seconds),
            ErrorCode::InvalidTimeout
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
        )?;

        let now = Clock::get()?.unix_timestamp;
        let payment = &mut ctx.accounts.payment;
        payment.buyer = ctx.accounts.buyer.key();
        payment.merchant = ctx.accounts.merchant.key();
        payment.mint = ctx.accounts.mint.key();
        payment.order_id = order_id;
        payment.amount = amount;
        payment.fee_amount = 0;
        payment.status = PaymentStatus::EscrowHeld;
        payment.created_at = now;
        payment.expiry = now
            .checked_add(timeout_seconds)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payment.bump = ctx.bumps.payment;
        payment.vault_bump = ctx.bumps.escrow_vault;

        emit!(PaymentInitiated {
            buyer: payment.buyer,
            merchant: payment.merchant,
            mint: payment.mint,
            order_id,
            amount,
            expiry: payment.expiry,
        });
        Ok(())
    }

    /// The buyer confirms the order arrived. Releases the escrow to the merchant.
    pub fn confirm_delivery(ctx: Context<ConfirmDelivery>, order_id: u64) -> Result<()> {
        let payment = &ctx.accounts.payment;
        require!(
            payment.status == PaymentStatus::EscrowHeld,
            ErrorCode::InvalidPaymentStatus
        );
        require!(payment.order_id == order_id, ErrorCode::InvalidOrder);

        let amount = payment.amount;
        let fee = settlement_fee(amount)?;
        let to_merchant = amount.checked_sub(fee).ok_or(ErrorCode::ArithmeticOverflow)?;

        take_fee(
            &ctx.accounts.token_program,
            &ctx.accounts.escrow_vault,
            &ctx.accounts.treasury_token,
            &ctx.accounts.payment,
            fee,
            order_id,
        )?;
        release(
            &ctx.accounts.token_program,
            &ctx.accounts.escrow_vault,
            &ctx.accounts.merchant_token,
            &ctx.accounts.payment,
            ctx.accounts.buyer.to_account_info(),
            to_merchant,
            order_id,
        )?;

        let payment = &mut ctx.accounts.payment;
        payment.status = PaymentStatus::Settled;
        payment.fee_amount = fee;

        emit!(PaymentSettled {
            buyer: payment.buyer,
            merchant: payment.merchant,
            order_id,
            amount,
            fee,
            outcome: PaymentStatus::Settled,
        });
        Ok(())
    }

    /// Settles up to `MAX_BATCH_SIZE` orders in one transaction, instead of
    /// one `confirm_delivery` transaction per order.
    ///
    /// Same rule as `confirm_delivery` — the buyer signs, the merchant is
    /// paid, the fee is charged — just applied to a whole list of orders at
    /// once. Every four consecutive accounts in `remaining_accounts` are one
    /// order's `[payment, escrow_vault, merchant_token, treasury_token]`.
    /// All orders in one call must belong to this same buyer, since a
    /// transaction carries only the one signature.
    ///
    /// This exists purely to amortize Solana's per-transaction signature fee
    /// and confirmation wait across many orders — it changes nothing about
    /// custody or the settlement rule itself, and reuses the exact same
    /// `release`/`take_fee` helpers `confirm_delivery` uses one order at a
    /// time.
    pub fn batch_confirm_delivery(ctx: Context<BatchConfirmDelivery>) -> Result<()> {
        let remaining = ctx.remaining_accounts;
        require!(!remaining.is_empty(), ErrorCode::InvalidBatchSize);
        require!(
            remaining.len() % ACCOUNTS_PER_BATCH_ORDER == 0,
            ErrorCode::InvalidBatchSize
        );
        let order_count = remaining.len() / ACCOUNTS_PER_BATCH_ORDER;
        require!(order_count <= MAX_BATCH_SIZE, ErrorCode::InvalidBatchSize);

        let buyer_key = ctx.accounts.buyer.key();

        for i in 0..order_count {
            let base = i * ACCOUNTS_PER_BATCH_ORDER;
            let payment_info = &remaining[base];
            let vault_info = &remaining[base + 1];
            let merchant_token_info = &remaining[base + 2];
            let treasury_token_info = &remaining[base + 3];

            // Same checks `#[account(seeds = ..., bump = payment.bump)]` runs
            // for a single typed account, written by hand because this
            // account's position in the account list is dynamic.
            let mut payment: Account<Payment> = Account::try_from(payment_info)?;
            require!(payment.buyer == buyer_key, ErrorCode::InvalidBuyer);
            require!(
                payment.status == PaymentStatus::EscrowHeld,
                ErrorCode::InvalidPaymentStatus
            );
            let expected_payment = Pubkey::create_program_address(
                &[
                    b"payment",
                    buyer_key.as_ref(),
                    payment.merchant.as_ref(),
                    &payment.order_id.to_le_bytes(),
                    &[payment.bump],
                ],
                ctx.program_id,
            )
            .map_err(|_| error!(ErrorCode::InvalidOrder))?;
            require!(
                expected_payment == payment_info.key(),
                ErrorCode::InvalidOrder
            );

            let vault: Account<TokenAccount> = Account::try_from(vault_info)?;
            let expected_vault = Pubkey::create_program_address(
                &[b"vault", payment_info.key().as_ref(), &[payment.vault_bump]],
                ctx.program_id,
            )
            .map_err(|_| error!(ErrorCode::InvalidOrder))?;
            require!(expected_vault == vault_info.key(), ErrorCode::InvalidOrder);

            let merchant_token: Account<TokenAccount> = Account::try_from(merchant_token_info)?;
            require!(
                merchant_token.owner == payment.merchant,
                ErrorCode::InvalidTokenOwner
            );
            require!(merchant_token.mint == payment.mint, ErrorCode::InvalidMint);

            let treasury_token: Account<TokenAccount> = Account::try_from(treasury_token_info)?;
            require!(treasury_token.owner == TREASURY, ErrorCode::InvalidTreasury);
            require!(treasury_token.mint == payment.mint, ErrorCode::InvalidMint);

            let amount = payment.amount;
            let fee = settlement_fee(amount)?;
            let to_merchant = amount.checked_sub(fee).ok_or(ErrorCode::ArithmeticOverflow)?;
            let order_id = payment.order_id;

            take_fee(
                &ctx.accounts.token_program,
                &vault,
                &treasury_token,
                &payment,
                fee,
                order_id,
            )?;
            release(
                &ctx.accounts.token_program,
                &vault,
                &merchant_token,
                &payment,
                ctx.accounts.buyer.to_account_info(),
                to_merchant,
                order_id,
            )?;

            payment.status = PaymentStatus::Settled;
            payment.fee_amount = fee;
            payment.exit(ctx.program_id)?;

            emit!(PaymentSettled {
                buyer: payment.buyer,
                merchant: payment.merchant,
                order_id,
                amount,
                fee,
                outcome: PaymentStatus::Settled,
            });
        }

        Ok(())
    }

    /// Cancels an order by mutual agreement: both the buyer and the merchant
    /// sign, and the money goes back to the buyer in full with no fee.
    ///
    /// Requiring both signatures is what stops each side rugging the other. A
    /// buyer alone could otherwise take delivery and pull the money back; a
    /// merchant alone could cancel an order they had already been paid for.
    /// Either party acting unilaterally has exactly one route — the buyer waits
    /// for the expiry and calls `reclaim_timeout`, the merchant asks the buyer
    /// to confirm.
    pub fn refund_escrow(ctx: Context<RefundEscrow>, order_id: u64) -> Result<()> {
        let payment = &ctx.accounts.payment;
        require!(
            payment.status == PaymentStatus::EscrowHeld,
            ErrorCode::InvalidPaymentStatus
        );
        require!(payment.order_id == order_id, ErrorCode::InvalidOrder);

        let amount = payment.amount;
        release(
            &ctx.accounts.token_program,
            &ctx.accounts.escrow_vault,
            &ctx.accounts.buyer_token,
            &ctx.accounts.payment,
            ctx.accounts.buyer.to_account_info(),
            amount,
            order_id,
        )?;

        let payment = &mut ctx.accounts.payment;
        payment.status = PaymentStatus::Refunded;

        emit!(PaymentSettled {
            buyer: payment.buyer,
            merchant: payment.merchant,
            order_id,
            amount,
            fee: 0,
            outcome: PaymentStatus::Refunded,
        });
        Ok(())
    }

    /// The merchant never delivered. After the expiry the buyer takes the
    /// escrow back alone — no merchant signature, no operator, nothing the
    /// merchant can do to block it.
    pub fn reclaim_timeout(ctx: Context<ReclaimTimeout>, order_id: u64) -> Result<()> {
        let payment = &ctx.accounts.payment;
        require!(
            payment.status == PaymentStatus::EscrowHeld,
            ErrorCode::InvalidPaymentStatus
        );
        require!(payment.order_id == order_id, ErrorCode::InvalidOrder);
        require!(
            Clock::get()?.unix_timestamp >= payment.expiry,
            ErrorCode::ReclaimNotYetAvailable
        );

        let amount = payment.amount;
        release(
            &ctx.accounts.token_program,
            &ctx.accounts.escrow_vault,
            &ctx.accounts.buyer_token,
            &ctx.accounts.payment,
            ctx.accounts.buyer.to_account_info(),
            amount,
            order_id,
        )?;

        let payment = &mut ctx.accounts.payment;
        payment.status = PaymentStatus::Reclaimed;

        emit!(PaymentSettled {
            buyer: payment.buyer,
            merchant: payment.merchant,
            order_id,
            amount,
            fee: 0,
            outcome: PaymentStatus::Reclaimed,
        });
        Ok(())
    }

    /// Reclaims the rent of a finished Payment account.
    ///
    /// x402 is built for micropayments, and an account left open forever costs
    /// more rent than a small payment is worth. The order's history survives in
    /// the events emitted above, which indexers read, so closing the account
    /// loses nothing an archival node cannot reconstruct.
    pub fn close_payment(ctx: Context<ClosePayment>, order_id: u64) -> Result<()> {
        let payment = &ctx.accounts.payment;
        require!(
            payment.status != PaymentStatus::EscrowHeld,
            ErrorCode::PaymentStillOpen
        );
        require!(payment.order_id == order_id, ErrorCode::InvalidOrder);
        Ok(())
    }
}

/// Moves `amount` out of the vault and closes it, signing as the Payment PDA.
///
/// Every release in this program goes through here so the signer seeds are
/// written once: getting them wrong is the classic way an escrow either stops
/// working or stops being safe.
fn release<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    destination: &Account<'info, TokenAccount>,
    payment: &Account<'info, Payment>,
    rent_destination: AccountInfo<'info>,
    amount: u64,
    order_id: u64,
) -> Result<()> {
    let buyer = payment.buyer;
    let merchant = payment.merchant;
    let bump = payment.bump;
    let order_id_bytes = order_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[
        b"payment",
        buyer.as_ref(),
        merchant.as_ref(),
        &order_id_bytes,
        &[bump],
    ];

    if amount > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: vault.to_account_info(),
                    to: destination.to_account_info(),
                    authority: payment.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;
    }

    // The vault has done its job; return its rent to whoever funded it.
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_destination,
            authority: payment.to_account_info(),
        },
        &[signer_seeds],
    ))?;
    Ok(())
}

/// Moves the settlement fee out of the vault, leaving the rest for the merchant.
/// Kept separate from `release` because `release` also closes the vault, and the
/// fee has to be paid while it is still open.
fn take_fee<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    treasury_token: &Account<'info, TokenAccount>,
    payment: &Account<'info, Payment>,
    fee: u64,
    order_id: u64,
) -> Result<()> {
    if fee == 0 {
        return Ok(());
    }
    let buyer = payment.buyer;
    let merchant = payment.merchant;
    let bump = payment.bump;
    let order_id_bytes = order_id.to_le_bytes();
    let signer_seeds: &[&[u8]] = &[
        b"payment",
        buyer.as_ref(),
        merchant.as_ref(),
        &order_id_bytes,
        &[bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: treasury_token.to_account_info(),
                authority: payment.to_account_info(),
            },
            &[signer_seeds],
        ),
        fee,
    )
}

/// The settlement fee for an order. Rounds down, so a payment too small to
/// carry a fee simply pays none rather than being rejected.
fn settlement_fee(amount: u64) -> Result<u64> {
    let fee = (amount as u128)
        .checked_mul(FEE_BPS as u128)
        .ok_or(ErrorCode::ArithmeticOverflow)?
        / 10_000u128;
    Ok(fee as u64)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Payment {
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    /// The SPL mint this order settles in.
    pub mint: Pubkey,
    pub order_id: u64,
    /// The full order price. All of it is escrowed.
    pub amount: u64,
    /// The settlement fee actually charged. Zero until the order settles, and
    /// zero forever on a refund or reclaim.
    pub fee_amount: u64,
    pub status: PaymentStatus,
    pub created_at: i64,
    /// Reclaim becomes available at this unix timestamp.
    pub expiry: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum PaymentStatus {
    EscrowHeld,
    Settled,
    Refunded,
    Reclaimed,
}

// ---------------------------------------------------------------------------
// Events — the order history, once Payment accounts are closed.
// ---------------------------------------------------------------------------

#[event]
pub struct PaymentInitiated {
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub order_id: u64,
    pub amount: u64,
    pub expiry: i64,
}

#[event]
pub struct PaymentSettled {
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    pub order_id: u64,
    pub amount: u64,
    pub fee: u64,
    pub outcome: PaymentStatus,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(amount: u64, order_id: u64)]
pub struct InitiatePayment<'info> {
    #[account(
        init,
        payer = buyer,
        space = 8 + Payment::INIT_SPACE,
        seeds = [b"payment", buyer.key().as_ref(), merchant.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump
    )]
    pub payment: Box<Account<'info, Payment>>,

    /// The merchant being paid. Only their address is needed — this program
    /// keeps no merchant record of any kind.
    /// CHECK: used solely as a PDA seed and stored for later settlement.
    pub merchant: UncheckedAccount<'info>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        constraint = buyer_token.owner == buyer.key() @ ErrorCode::InvalidTokenOwner,
        constraint = buyer_token.mint == mint.key() @ ErrorCode::InvalidMint,
    )]
    pub buyer_token: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = buyer,
        seeds = [b"vault", payment.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = payment,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    pub mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct ConfirmDelivery<'info> {
    #[account(
        mut,
        seeds = [b"payment", buyer.key().as_ref(), payment.merchant.as_ref(), order_id.to_le_bytes().as_ref()],
        bump = payment.bump,
    )]
    pub payment: Box<Account<'info, Payment>>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", payment.key().as_ref()],
        bump = payment.vault_bump,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = merchant_token.owner == payment.merchant @ ErrorCode::InvalidTokenOwner,
        constraint = merchant_token.mint == payment.mint @ ErrorCode::InvalidMint,
    )]
    pub merchant_token: Box<Account<'info, TokenAccount>>,

    /// Receives the settlement fee. Constrained to the compiled-in treasury, so
    /// the caller cannot redirect the fee to themselves.
    #[account(
        mut,
        constraint = treasury_token.owner == TREASURY @ ErrorCode::InvalidTreasury,
        constraint = treasury_token.mint == payment.mint @ ErrorCode::InvalidMint,
    )]
    pub treasury_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Fixed accounts for `batch_confirm_delivery`. Everything order-specific
/// arrives via `ctx.remaining_accounts` instead — see that function's doc
/// comment for the per-order account layout.
#[derive(Accounts)]
pub struct BatchConfirmDelivery<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct RefundEscrow<'info> {
    #[account(
        mut,
        seeds = [b"payment", buyer.key().as_ref(), merchant.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump = payment.bump,
    )]
    pub payment: Box<Account<'info, Payment>>,

    /// The refund is the merchant's own decision, so they sign it. Without this
    /// a buyer could take delivery and then pull the money back at will.
    #[account(constraint = merchant.key() == payment.merchant @ ErrorCode::InvalidMerchant)]
    pub merchant: Signer<'info>,

    /// The buyer signs too: a refund is a cancellation both sides agree to.
    #[account(mut, constraint = buyer.key() == payment.buyer @ ErrorCode::InvalidBuyer)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", payment.key().as_ref()],
        bump = payment.vault_bump,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_token.owner == payment.buyer @ ErrorCode::InvalidTokenOwner,
        constraint = buyer_token.mint == payment.mint @ ErrorCode::InvalidMint,
    )]
    pub buyer_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct ReclaimTimeout<'info> {
    #[account(
        mut,
        seeds = [b"payment", buyer.key().as_ref(), payment.merchant.as_ref(), order_id.to_le_bytes().as_ref()],
        bump = payment.bump,
    )]
    pub payment: Box<Account<'info, Payment>>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", payment.key().as_ref()],
        bump = payment.vault_bump,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_token.owner == payment.buyer @ ErrorCode::InvalidTokenOwner,
        constraint = buyer_token.mint == payment.mint @ ErrorCode::InvalidMint,
    )]
    pub buyer_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct ClosePayment<'info> {
    #[account(
        mut,
        seeds = [b"payment", buyer.key().as_ref(), payment.merchant.as_ref(), order_id.to_le_bytes().as_ref()],
        bump = payment.bump,
        close = buyer,
    )]
    pub payment: Box<Account<'info, Payment>>,

    #[account(mut, constraint = buyer.key() == payment.buyer @ ErrorCode::InvalidBuyer)]
    pub buyer: Signer<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Payment amount must be greater than zero")]
    InvalidAmount,
    #[msg("Timeout must be between 60 seconds and 30 days")]
    InvalidTimeout,
    #[msg("Invalid payment status for this operation")]
    InvalidPaymentStatus,
    #[msg("Order ID mismatch")]
    InvalidOrder,
    #[msg("Reclaim is not available until the escrow expires")]
    ReclaimNotYetAvailable,
    #[msg("Token account owner does not match the expected party")]
    InvalidTokenOwner,
    #[msg("Token account mint does not match the payment's mint")]
    InvalidMint,
    #[msg("Signer is not the merchant on this payment")]
    InvalidMerchant,
    #[msg("Signer is not the buyer on this payment")]
    InvalidBuyer,
    #[msg("Fee destination is not the protocol treasury")]
    InvalidTreasury,
    #[msg("Cannot close a payment whose escrow is still held")]
    PaymentStillOpen,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Batch must contain 1 to MAX_BATCH_SIZE orders' worth of accounts, 4 per order")]
    InvalidBatchSize,
}
