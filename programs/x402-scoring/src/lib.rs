use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4");

// ---------------------------------------------------------------------------
// Agent CTOS Anti-Rug Escrow Program
//
// A merchant-underwriting escrow for x402 payments on Solana. Every merchant
// is scored purely from on-chain settlement history (no human overrides) and
// every payment's escrow requirement is derived deterministically from that
// history, following the twelve anti-rug rules below. All merchant and
// payment state lives in on-chain PDAs (not an off-chain database) so any
// buyer, judge, or indexer can verify a merchant's tier, reserve math, and
// full settlement history directly on Solana Explorer.
//
// Anti-Rug Rules -> where they are enforced:
//   1.  Reserve scales with tx size          -> reserve_amount()
//   2.  Size multiplier by tier              -> TIER_MULTIPLIER / tier_multiplier()
//   3.  No N-x jumps                         -> initiate_payment() size-anomaly branch
//   4.  New addresses = zero trust           -> initiate_payment() is_new / tier==1 branch
//   5.  Refund rate signal                   -> Merchant::rates_bps() + refund_escrow()
//   6.  Reclaim rate signal                  -> Merchant::rates_bps() + reclaim_timeout()
//   7.  Completed volume is input             -> Merchant::record_completed() (never on Pending)
//   8.  No human opinion                     -> recompute_tier() is pure function of counters
//   9.  Trust <= collateral                  -> escrow always funded atomically in initiate_payment()
//   10. Velocity check                       -> same check as rule 2/3 (avg-relative anomaly)
//   11. Reserve survives tier changes        -> Payment.escrow_amount is immutable after creation
//   12. Cold-start cost after a rug          -> reclaim_timeout() resets tier to 1 + tier_floor_tx_count
// ---------------------------------------------------------------------------

/// Escrow reserve as a fraction of tx size, in basis points, per tier (rule 1 & 2).
/// Tier 1 is always 100% (see rule 4), tiers 2-4 hold a shrinking slice as collateral.
const RESERVE_BPS: [u64; 4] = [10_000, 1_000, 300, 100];

/// How many multiples of the merchant's historical average tx size a single
/// payment may reach before it is forced into full escrow regardless of tier
/// (rule 2, rule 3, rule 10).
const TIER_MULTIPLIER: [u64; 4] = [2, 10, 50, 100];

/// A small flat minimum held on every escrowed payment in addition to the
/// size-scaled slice, in the payment token's base units (rule 1's `base_reserve`).
const BASE_RESERVE: u64 = 1_000;

/// Refund-rate / reclaim-rate thresholds (basis points of settled transactions)
/// above which a merchant is demoted a tier (rule 5, rule 6).
const REFUND_RATE_THRESHOLD_BPS: u64 = 500; // 5%
const RECLAIM_RATE_THRESHOLD_BPS: u64 = 300; // 3%

/// Minimum completed (settled) transaction counts required before a merchant
/// may hold each tier (rule 8: purely mechanical, no discretionary promotion).
const MIN_TX_TIER_2: u64 = 5;
const MIN_TX_TIER_3: u64 = 20;
const MIN_TX_TIER_4: u64 = 50;

/// After a reclaim (rug signal), how many additional completed transactions a
/// merchant must rebuild before they can be promoted out of tier 1 again
/// (rule 12: cold-start cost).
const REBUILD_TX_REQUIREMENT: u64 = 10;

const MIN_TIMEOUT_SECONDS: i64 = 60;
const MAX_TIMEOUT_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

fn tier_index(tier: u8) -> usize {
    (tier.clamp(1, 4) - 1) as usize
}

fn tier_multiplier(tier: u8) -> u64 {
    TIER_MULTIPLIER[tier_index(tier)]
}

fn reserve_bps(tier: u8) -> u64 {
    RESERVE_BPS[tier_index(tier)]
}

/// Rule 1: escrow_amount = base_reserve + (tx_size * risk_multiplier), clamped to tx_size.
fn reserve_amount(amount: u64, tier: u8) -> Result<u64> {
    let scaled = (amount as u128)
        .checked_mul(reserve_bps(tier) as u128)
        .ok_or(error!(ErrorCode::ArithmeticOverflow))?
        / 10_000u128;
    let total = scaled
        .checked_add(BASE_RESERVE as u128)
        .ok_or(error!(ErrorCode::ArithmeticOverflow))?;
    let total: u64 = total
        .try_into()
        .map_err(|_| error!(ErrorCode::ArithmeticOverflow))?;
    Ok(total.min(amount))
}

#[program]
pub mod x402_scoring {
    use super::*;

    /// Registers a brand-new merchant. Rule 4: a fresh address gets zero
    /// inherited trust — tier 1, no history, no shortcuts from rotating keys.
    pub fn register_merchant(ctx: Context<RegisterMerchant>) -> Result<()> {
        let merchant = &mut ctx.accounts.merchant;
        merchant.address = ctx.accounts.owner.key();
        merchant.mint = ctx.accounts.mint.key();
        merchant.tier = 1;
        merchant.completed_tx_count = 0;
        merchant.total_completed_volume = 0;
        merchant.avg_tx_size = 0;
        merchant.refund_count = 0;
        merchant.reclaim_count = 0;
        merchant.total_settlement_events = 0;
        merchant.tier_floor_tx_count = 0;
        merchant.created_at = Clock::get()?.unix_timestamp;
        merchant.bump = ctx.bumps.merchant;
        Ok(())
    }

    /// The `/verify`-time decision tree. Computes how much of `amount` must
    /// sit in escrow versus settle instantly, and moves the funds atomically.
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

        let merchant = &mut ctx.accounts.merchant;

        // Rule 8: tier is a pure function of the merchant's counters, so derive
        // it here rather than pricing against a possibly stale stored value.
        // This is the same function `recompute_tier` exposes permissionlessly —
        // a merchant whose refund/reclaim rates have gone bad lands on the exact
        // tier it would land on there, no matter which instruction ran first.
        merchant.recompute_tier();

        let is_new = merchant.completed_tx_count == 0;

        let mut forced_full_escrow = false;
        let escrow_amount: u64;

        if is_new || merchant.tier == 1 {
            // Rule 4/5/6: new merchants, and any merchant demoted to tier 1 by
            // its settlement history, are 100% escrowed with no exceptions.
            escrow_amount = amount;
        } else {
            // Rule 2/3/10: size & velocity check against the merchant's own history.
            let allowed_max = merchant
                .avg_tx_size
                .checked_mul(tier_multiplier(merchant.tier))
                .ok_or(ErrorCode::ArithmeticOverflow)?;

            if amount > allowed_max {
                // Rule 3: no N-x jumps — force full escrow for this tx only.
                escrow_amount = amount;
                forced_full_escrow = true;
            } else {
                // Rule 1/9: minimal, size-scaled collateral for a proven merchant.
                escrow_amount = reserve_amount(amount, merchant.tier)?;
            }
        }

        let escrow_amount = escrow_amount.min(amount);
        let instant_amount = amount
            .checked_sub(escrow_amount)
            .ok_or(ErrorCode::ArithmeticUnderflow)?;
        let tier_at_payment = merchant.tier;

        if instant_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_token.to_account_info(),
                        to: ctx.accounts.merchant_token.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                instant_amount,
            )?;
        }

        if escrow_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_token.to_account_info(),
                        to: ctx.accounts.escrow_vault.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                escrow_amount,
            )?;
        }

        let now = Clock::get()?.unix_timestamp;
        let payment_bump = ctx.bumps.payment;

        if escrow_amount == 0 {
            // Nothing to hold: the vault we just created is empty, close it
            // immediately so the buyer isn't paying rent for an unused account.
            let buyer_key = ctx.accounts.buyer.key();
            let merchant_key = ctx.accounts.merchant.key();
            let order_id_bytes = order_id.to_le_bytes();
            let signer_seeds: &[&[u8]] = &[
                b"payment",
                buyer_key.as_ref(),
                merchant_key.as_ref(),
                &order_id_bytes,
                &[payment_bump],
            ];
            token::close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.escrow_vault.to_account_info(),
                    destination: ctx.accounts.buyer.to_account_info(),
                    authority: ctx.accounts.payment.to_account_info(),
                },
                &[signer_seeds],
            ))?;
        }

        let merchant = &mut ctx.accounts.merchant;
        if escrow_amount == 0 {
            // Rule 7: an instantly-settled payment is complete the moment it
            // lands — count it toward volume/history right away.
            merchant.record_completed(amount)?;
            merchant.recompute_tier();
        }

        let payment = &mut ctx.accounts.payment;
        payment.buyer = ctx.accounts.buyer.key();
        payment.merchant = ctx.accounts.merchant.key();
        payment.mint = ctx.accounts.mint.key();
        payment.order_id = order_id;
        payment.amount = amount;
        payment.escrow_amount = escrow_amount;
        payment.instant_amount = instant_amount;
        payment.tier_at_payment = tier_at_payment;
        payment.forced_full_escrow = forced_full_escrow;
        payment.status = if escrow_amount == 0 {
            PaymentStatus::Settled
        } else {
            PaymentStatus::EscrowHeld
        };
        payment.created_at = now;
        payment.expiry = now
            .checked_add(timeout_seconds)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payment.bump = payment_bump;
        payment.vault_bump = ctx.bumps.escrow_vault;

        Ok(())
    }

    /// Buyer confirms delivery: escrowed funds (if any) release to the
    /// merchant and the order counts toward the merchant's completed history.
    pub fn confirm_delivery(ctx: Context<ConfirmDelivery>, order_id: u64) -> Result<()> {
        let payment = &ctx.accounts.payment;
        require!(
            payment.status == PaymentStatus::EscrowHeld,
            ErrorCode::InvalidPaymentStatus
        );
        require!(payment.order_id == order_id, ErrorCode::InvalidOrder);

        let escrow_amount = payment.escrow_amount;
        let order_amount = payment.amount;
        let payment_buyer = payment.buyer;
        let payment_merchant = payment.merchant;
        let payment_bump = payment.bump;
        let order_id_bytes = order_id.to_le_bytes();
        let signer_seeds: &[&[u8]] = &[
            b"payment",
            payment_buyer.as_ref(),
            payment_merchant.as_ref(),
            &order_id_bytes,
            &[payment_bump],
        ];

        if escrow_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.merchant_token.to_account_info(),
                        authority: ctx.accounts.payment.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                escrow_amount,
            )?;
        }

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_vault.to_account_info(),
                destination: ctx.accounts.buyer.to_account_info(),
                authority: ctx.accounts.payment.to_account_info(),
            },
            &[signer_seeds],
        ))?;

        let merchant = &mut ctx.accounts.merchant;
        merchant.record_completed(order_amount)?;
        merchant.recompute_tier();

        let payment = &mut ctx.accounts.payment;
        payment.status = PaymentStatus::Settled;

        Ok(())
    }

    /// Buyer voluntarily refunds an escrowed order before confirming delivery
    /// (rule 5 signal: this raises the merchant's refund rate going forward).
    pub fn refund_escrow(ctx: Context<RefundEscrow>, order_id: u64) -> Result<()> {
        let payment = &ctx.accounts.payment;
        require!(
            payment.status == PaymentStatus::EscrowHeld,
            ErrorCode::InvalidPaymentStatus
        );
        require!(payment.order_id == order_id, ErrorCode::InvalidOrder);

        let escrow_amount = payment.escrow_amount;
        let payment_buyer = payment.buyer;
        let payment_merchant = payment.merchant;
        let payment_bump = payment.bump;
        let order_id_bytes = order_id.to_le_bytes();
        let signer_seeds: &[&[u8]] = &[
            b"payment",
            payment_buyer.as_ref(),
            payment_merchant.as_ref(),
            &order_id_bytes,
            &[payment_bump],
        ];

        if escrow_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.buyer_token.to_account_info(),
                        authority: ctx.accounts.payment.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                escrow_amount,
            )?;
        }

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_vault.to_account_info(),
                destination: ctx.accounts.buyer.to_account_info(),
                authority: ctx.accounts.payment.to_account_info(),
            },
            &[signer_seeds],
        ))?;

        let merchant = &mut ctx.accounts.merchant;
        merchant.refund_count = merchant
            .refund_count
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        merchant.total_settlement_events = merchant
            .total_settlement_events
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        merchant.recompute_tier();

        let payment = &mut ctx.accounts.payment;
        payment.status = PaymentStatus::Refunded;

        Ok(())
    }

    /// After the expiry passes without a delivery confirmation, the buyer can
    /// unilaterally pull their escrowed funds back — no merchant or operator
    /// signature required (rule 6, rule 12: this is the rug signal).
    pub fn reclaim_timeout(ctx: Context<ReclaimTimeout>, order_id: u64) -> Result<()> {
        let payment = &ctx.accounts.payment;
        require!(
            payment.status == PaymentStatus::EscrowHeld,
            ErrorCode::InvalidPaymentStatus
        );
        require!(payment.order_id == order_id, ErrorCode::InvalidOrder);
        require!(
            Clock::get()?.unix_timestamp > payment.expiry,
            ErrorCode::ReclaimNotYetAvailable
        );

        let escrow_amount = payment.escrow_amount;
        let payment_buyer = payment.buyer;
        let payment_merchant = payment.merchant;
        let payment_bump = payment.bump;
        let order_id_bytes = order_id.to_le_bytes();
        let signer_seeds: &[&[u8]] = &[
            b"payment",
            payment_buyer.as_ref(),
            payment_merchant.as_ref(),
            &order_id_bytes,
            &[payment_bump],
        ];

        if escrow_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.buyer_token.to_account_info(),
                        authority: ctx.accounts.payment.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                escrow_amount,
            )?;
        }

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_vault.to_account_info(),
                destination: ctx.accounts.buyer.to_account_info(),
                authority: ctx.accounts.payment.to_account_info(),
            },
            &[signer_seeds],
        ))?;

        let merchant = &mut ctx.accounts.merchant;
        merchant.reclaim_count = merchant
            .reclaim_count
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        merchant.total_settlement_events = merchant
            .total_settlement_events
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        // Rule 12: cold-start cost. A reclaim means the merchant took the
        // buyer's collateral-relief and still failed to deliver in time —
        // reset to tier 1 and lock out promotion until fresh volume rebuilds.
        merchant.tier = 1;
        merchant.tier_floor_tx_count = merchant
            .completed_tx_count
            .checked_add(REBUILD_TX_REQUIREMENT)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        let payment = &mut ctx.accounts.payment;
        payment.status = PaymentStatus::Reclaimed;

        Ok(())
    }

    /// Permissionless, deterministic tier recalculation (rule 8: no human
    /// opinion — anyone can call this, and it always produces the same
    /// answer from the merchant's on-chain counters).
    pub fn recompute_tier(ctx: Context<RecomputeTier>) -> Result<()> {
        ctx.accounts.merchant.recompute_tier();
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Merchant {
    pub address: Pubkey,
    /// The single SPL mint this merchant settles in, fixed at registration.
    /// Reputation is denominated: `avg_tx_size` and `total_completed_volume`
    /// are only meaningful if every payment counted into them is in the same
    /// unit, so payments in any other mint are rejected outright.
    pub mint: Pubkey,
    /// 1 = new/unproven, 2 = proven, 3 = trusted, 4 = excellent.
    pub tier: u8,
    /// Only settled/confirmed transactions count here (rule 7).
    pub completed_tx_count: u64,
    pub total_completed_volume: u64,
    /// Running average of completed transaction size; the baseline for the
    /// size/velocity check (rule 2, rule 3, rule 10).
    pub avg_tx_size: u64,
    pub refund_count: u64,
    pub reclaim_count: u64,
    /// completed + refunded + reclaimed; denominator for the rate signals.
    pub total_settlement_events: u64,
    /// Cold-start floor (rule 12): tier cannot rise above 1 until
    /// completed_tx_count reaches this value.
    pub tier_floor_tx_count: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl Merchant {
    pub fn rates_bps(&self) -> (u64, u64) {
        if self.total_settlement_events == 0 {
            return (0, 0);
        }
        let denom = self.total_settlement_events as u128;
        let refund_bps = (self.refund_count as u128 * 10_000 / denom) as u64;
        let reclaim_bps = (self.reclaim_count as u128 * 10_000 / denom) as u64;
        (refund_bps, reclaim_bps)
    }

    /// Rule 7: folds one more confirmed settlement into the merchant's
    /// history and updates the running average tx size used for sizing future escrow.
    pub fn record_completed(&mut self, amount: u64) -> Result<()> {
        let n = self.completed_tx_count as u128;
        let new_n = n.checked_add(1).ok_or(ErrorCode::ArithmeticOverflow)?;
        let total = (self.avg_tx_size as u128)
            .checked_mul(n)
            .and_then(|v| v.checked_add(amount as u128))
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        let new_avg = total
            .checked_div(new_n)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        self.avg_tx_size = new_avg
            .try_into()
            .map_err(|_| error!(ErrorCode::ArithmeticOverflow))?;
        self.completed_tx_count = new_n
            .try_into()
            .map_err(|_| error!(ErrorCode::ArithmeticOverflow))?;
        self.total_completed_volume = self
            .total_completed_volume
            .checked_add(amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        self.total_settlement_events = self
            .total_settlement_events
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        Ok(())
    }

    /// Rule 8: pure function of on-chain counters, no discretionary input.
    pub fn recompute_tier(&mut self) {
        let (refund_bps, reclaim_bps) = self.rates_bps();
        let clean =
            refund_bps <= REFUND_RATE_THRESHOLD_BPS && reclaim_bps <= RECLAIM_RATE_THRESHOLD_BPS;

        let mut new_tier: u8 = 1;
        if self.completed_tx_count >= self.tier_floor_tx_count {
            if clean && self.completed_tx_count >= MIN_TX_TIER_4 {
                new_tier = 4;
            } else if clean && self.completed_tx_count >= MIN_TX_TIER_3 {
                new_tier = 3;
            } else if clean && self.completed_tx_count >= MIN_TX_TIER_2 {
                new_tier = 2;
            }
        }
        self.tier = new_tier;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Payment {
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    /// Settlement mint, snapshotted so an audit of this payment never has to
    /// trust the merchant account's current state.
    pub mint: Pubkey,
    pub order_id: u64,
    pub amount: u64,
    /// Portion of `amount` held in the escrow vault (rule 1/9).
    pub escrow_amount: u64,
    /// Portion of `amount` sent straight to the merchant at initiation.
    pub instant_amount: u64,
    /// Merchant tier at the moment of payment, snapshotted for audit.
    /// escrow_amount is never re-derived from a later tier (rule 11).
    pub tier_at_payment: u8,
    /// True if the size/velocity anomaly check (rule 3/10) forced full
    /// escrow on this payment regardless of merchant tier.
    pub forced_full_escrow: bool,
    pub status: PaymentStatus,
    pub created_at: i64,
    /// Reclaim becomes available after this unix timestamp.
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

#[derive(Accounts)]
pub struct RegisterMerchant<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + Merchant::INIT_SPACE,
        seeds = [b"merchant", owner.key().as_ref()],
        bump
    )]
    pub merchant: Account<'info, Merchant>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// The mint this merchant will settle in for the life of the account.
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

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
    pub payment: Account<'info, Payment>,

    #[account(
        mut,
        seeds = [b"merchant", merchant.address.as_ref()],
        bump = merchant.bump,
        // Reputation is denominated: a payment in any mint other than the one
        // the merchant registered would corrupt avg_tx_size, and with it the
        // size-anomaly check that prices every future payment.
        constraint = merchant.mint == mint.key() @ ErrorCode::MintMismatch,
    )]
    pub merchant: Account<'info, Merchant>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        constraint = buyer_token.owner == buyer.key() @ ErrorCode::InvalidTokenOwner,
        constraint = buyer_token.mint == mint.key() @ ErrorCode::InvalidMint,
    )]
    pub buyer_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = merchant_token.owner == merchant.address @ ErrorCode::InvalidTokenOwner,
        constraint = merchant_token.mint == mint.key() @ ErrorCode::InvalidMint,
    )]
    pub merchant_token: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = buyer,
        seeds = [b"vault", payment.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = payment,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct ConfirmDelivery<'info> {
    #[account(
        mut,
        seeds = [b"payment", buyer.key().as_ref(), merchant.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump = payment.bump,
    )]
    pub payment: Account<'info, Payment>,

    #[account(
        mut,
        seeds = [b"merchant", merchant.address.as_ref()],
        bump = merchant.bump,
    )]
    pub merchant: Account<'info, Merchant>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", payment.key().as_ref()],
        bump = payment.vault_bump,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = merchant_token.owner == merchant.address @ ErrorCode::InvalidTokenOwner,
    )]
    pub merchant_token: Account<'info, TokenAccount>,

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
    pub payment: Account<'info, Payment>,

    #[account(
        mut,
        seeds = [b"merchant", merchant.address.as_ref()],
        bump = merchant.bump,
    )]
    pub merchant: Account<'info, Merchant>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", payment.key().as_ref()],
        bump = payment.vault_bump,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = buyer_token.owner == buyer.key() @ ErrorCode::InvalidTokenOwner,
    )]
    pub buyer_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct ReclaimTimeout<'info> {
    #[account(
        mut,
        seeds = [b"payment", buyer.key().as_ref(), merchant.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump = payment.bump,
    )]
    pub payment: Account<'info, Payment>,

    #[account(
        mut,
        seeds = [b"merchant", merchant.address.as_ref()],
        bump = merchant.bump,
    )]
    pub merchant: Account<'info, Merchant>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", payment.key().as_ref()],
        bump = payment.vault_bump,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = buyer_token.owner == buyer.key() @ ErrorCode::InvalidTokenOwner,
    )]
    pub buyer_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RecomputeTier<'info> {
    #[account(
        mut,
        seeds = [b"merchant", merchant.address.as_ref()],
        bump = merchant.bump,
    )]
    pub merchant: Account<'info, Merchant>,
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
    #[msg("Reclaim is not yet available before the escrow expiry")]
    ReclaimNotYetAvailable,
    #[msg("Token account owner does not match the expected party")]
    InvalidTokenOwner,
    #[msg("Token account mint does not match the expected mint")]
    InvalidMint,
    #[msg("Payment mint does not match the merchant's registered settlement mint")]
    MintMismatch,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Arithmetic underflow")]
    ArithmeticUnderflow,
}
