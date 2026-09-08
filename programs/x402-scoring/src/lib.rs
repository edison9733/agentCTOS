use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("HwyguqZ5QVJ5AWZQbeKZ6Cv4hCSowzDk7L9ujAC9zKz4");

// ---------------------------------------------------------------------------
// Agent CTOS — x402 Escrow, routed by collateral
//
// Every payment is split by a router that reads both parties before moving
// anything: how much of the order can be paid to the merchant *instantly*,
// uncollateralized, and how much must sit in escrow until one of exactly two
// things happens — the buyer confirms fulfillment, or the clock runs out.
//
// The instant portion is never a matter of trust. It is capped by collateral
// the merchant has actually posted (`MerchantReserve`) and gated by whether
// this specific buyer has ever completed an order before (`BuyerStanding`).
// If the merchant never delivers, `reclaim_timeout` does not just return the
// escrowed remainder — it skims the merchant's own posted reserve to make
// the buyer whole for the instant portion too. Extraction is bounded by
// collateral, not by knowing who anyone is.
//
// That is also why reputation stops being a fraud control here. Faking
// `BuyerStanding` cannot unlock more than a merchant's own reserve already
// covers, and faking `MerchantReserve` is impossible — it is real tokens,
// checked by the SPL token program, not a number a caller can set. A swarm
// of throwaway wallets has nothing to take: with no reserve or no history,
// every order defaults to full escrow, and a fully-escrowed order can always
// be reclaimed on timeout regardless of what anyone claims about themselves.
// ---------------------------------------------------------------------------

/// The protocol fee, in basis points, charged only on the *escrowed* portion
/// of an order when it settles successfully. The instant portion carries no
/// fee at all — a merchant who has posted real collateral has already paid
/// the cost of earning instant eligibility, and taxing the thing collateral
/// is meant to incentivize would undercut the incentive.
const FEE_BPS: u64 = 50; // 0.50%

/// Where settlement fees are sent. Compiled in, not stored in a config
/// account, so no admin instruction can redirect it.
pub const TREASURY: Pubkey = pubkey!("5i7zzV9hQUCbpg8MXSNJB3QQkL6zscDd8VQKow46vg7E");

/// Bounds on how long an escrow may run before the buyer can reclaim it.
const MIN_TIMEOUT_SECONDS: i64 = 60;
const MAX_TIMEOUT_SECONDS: i64 = 30 * 24 * 60 * 60; // 30 days

/// How long a merchant's unopposed fulfillment claim must sit before
/// `finalize_claim` can release it to them. Long enough for a genuine buyer
/// to notice and dispute; short enough that an absent buyer does not strand
/// an honest merchant indefinitely.
const CLAIM_DISPUTE_SECONDS: i64 = 24 * 60 * 60; // 24 hours

/// Named, published constants for the one attack this program does not
/// eliminate: a merchant that builds real `BuyerStanding`-eligible history,
/// then takes an instant payment on an order it never intends to deliver.
///
/// This build enforces strict 1:1 collateralization — `initiate_payment`
/// never lets the instant portion of an order exceed a merchant's own
/// currently-available reserve (see `route_payment` below) — so a bust-out
/// costs the merchant exactly its own forfeited collateral, and the buyer is
/// always made whole by the reserve skim in `reclaim_timeout`. There is no
/// leverage extended beyond posted collateral in this version.
///
/// `LIMIT_COEFFICIENT_K` and `RESERVE_SKIM_RATE_C` are published here for a
/// *leveraged* future version, where instant eligibility is extended some
/// bounded amount beyond raw reserve coverage. In that design, a patient
/// attacker's faked payoff grows like `k * sqrt(faked_volume)` while its
/// cost to fake grows linearly (`c * faked_volume`); the gap between them is
/// maximized at `k^2 / (4c)`, which becomes the known, chosen ceiling on
/// what that attack can ever extract. See README "Pricing the patient
/// attacker" for the worked number — publishing it, rather than leaving it
/// undiscovered, is the point of naming these constants at all.
#[allow(dead_code)]
const LIMIT_COEFFICIENT_K: u64 = 100;
#[allow(dead_code)]
const RESERVE_SKIM_RATE_C: u64 = 5;

#[program]
pub mod x402_scoring {
    use super::*;

    /// One-time setup: a merchant opens its collateral reserve. Must be
    /// called before `post_reserve` — separated from it so both use plain
    /// `init` rather than an init-if-needed pattern.
    pub fn open_reserve(ctx: Context<OpenReserve>) -> Result<()> {
        let reserve = &mut ctx.accounts.reserve;
        reserve.merchant = ctx.accounts.merchant.key();
        reserve.mint = ctx.accounts.mint.key();
        reserve.locked_exposure = 0;
        reserve.bump = ctx.bumps.reserve;
        reserve.vault_bump = ctx.bumps.reserve_vault;

        emit!(ReserveOpened {
            merchant: reserve.merchant,
            mint: reserve.mint,
        });
        Ok(())
    }

    /// Deposits collateral into an already-opened reserve. Callable any
    /// number of times to top it up.
    pub fn post_reserve(ctx: Context<PostReserve>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.merchant_token.to_account_info(),
                    to: ctx.accounts.reserve_vault.to_account_info(),
                    authority: ctx.accounts.merchant.to_account_info(),
                },
            ),
            amount,
        )?;
        emit!(ReservePosted {
            merchant: ctx.accounts.reserve.merchant,
            amount,
        });
        Ok(())
    }

    /// Withdraws collateral that is not currently backing an outstanding
    /// instant payment. A merchant can never pull collateral out from under
    /// an order it is still on the hook for.
    pub fn withdraw_reserve(ctx: Context<WithdrawReserve>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let reserve = &ctx.accounts.reserve;
        let available = ctx
            .accounts
            .reserve_vault
            .amount
            .checked_sub(reserve.locked_exposure)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        require!(amount <= available, ErrorCode::InsufficientReserve);

        // The vault's authority is the *reserve* account itself (see
        // `token::authority = reserve` in `OpenReserve`), so the CPI below
        // signs with the reserve's own seeds, not a separate vault PDA.
        let merchant = reserve.merchant;
        let reserve_bump = reserve.bump;
        let signer_seeds: &[&[u8]] = &[b"reserve", merchant.as_ref(), &[reserve_bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reserve_vault.to_account_info(),
                    to: ctx.accounts.merchant_token.to_account_info(),
                    authority: ctx.accounts.reserve.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;
        emit!(ReserveWithdrawn {
            merchant: ctx.accounts.reserve.merchant,
            amount,
        });
        Ok(())
    }

    /// One-time, optional setup: a buyer opts in to building `BuyerStanding`.
    /// A buyer who never calls this can still pay for anything — every one
    /// of their orders simply defaults to full escrow, the safe outcome,
    /// forever. There is no penalty for not registering, only no eligibility
    /// for instant settlement.
    pub fn register_buyer(ctx: Context<RegisterBuyer>) -> Result<()> {
        let standing = &mut ctx.accounts.standing;
        standing.buyer = ctx.accounts.buyer.key();
        standing.settled_count = 0;
        standing.bump = ctx.bumps.standing;
        Ok(())
    }

    /// Takes payment for one order and routes it: instantly to the merchant
    /// up to whatever its own posted reserve currently covers, for a buyer
    /// who has completed at least one order before; escrowed otherwise.
    /// `order_id`, together with the buyer and merchant, forms the Payment
    /// account's address, so a replayed order id is rejected by the runtime.
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

        let mint_key = ctx.accounts.mint.key();
        let merchant_key = ctx.accounts.merchant.key();
        let buyer_key = ctx.accounts.buyer.key();

        // -------- read the buyer's standing, if it has ever been opened.
        let established = if *ctx.accounts.buyer_standing.owner == crate::ID {
            let standing: BuyerStanding = read_account(&ctx.accounts.buyer_standing)?;
            require!(standing.buyer == buyer_key, ErrorCode::InvalidStanding);
            standing.settled_count > 0
        } else {
            false
        };

        // -------- read the merchant's available reserve, if one is open.
        let (reserve_exists, available_reserve) =
            if *ctx.accounts.merchant_reserve.owner == crate::ID {
                let reserve: MerchantReserve = read_account(&ctx.accounts.merchant_reserve)?;
                require!(reserve.merchant == merchant_key, ErrorCode::InvalidReserve);
                require!(reserve.mint == mint_key, ErrorCode::InvalidMint);
                let expected_vault = Pubkey::create_program_address(
                    &[b"reserve_vault", ctx.accounts.merchant_reserve.key.as_ref(), &[reserve.vault_bump]],
                    ctx.program_id,
                )
                .map_err(|_| error!(ErrorCode::InvalidReserve))?;
                require!(
                    expected_vault == ctx.accounts.reserve_vault.key(),
                    ErrorCode::InvalidReserve
                );
                let vault: TokenAccount = read_account(&ctx.accounts.reserve_vault)?;
                let available = vault.amount.saturating_sub(reserve.locked_exposure);
                (true, available)
            } else {
                (false, 0u64)
            };

        // -------- the router: apply the reserve x standing table.
        let (instant_amount, escrowed_amount) = if available_reserve >= amount && established {
            (amount, 0u64)
        } else if available_reserve > 0 && available_reserve < amount && established {
            (available_reserve, amount - available_reserve)
        } else {
            (0u64, amount)
        };

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

            // Lock this order's instant amount against the merchant's own
            // reserve. `reserve_exists` is guaranteed true here: instant_amount
            // can only be nonzero if available_reserve was read above, which
            // only happens when the reserve account actually exists.
            require!(reserve_exists, ErrorCode::InvalidReserve);
            let mut reserve: MerchantReserve = read_account(&ctx.accounts.merchant_reserve)?;
            reserve.locked_exposure = reserve
                .locked_exposure
                .checked_add(instant_amount)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            write_account(&ctx.accounts.merchant_reserve, &reserve)?;
        }

        if escrowed_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.buyer_token.to_account_info(),
                        to: ctx.accounts.escrow_vault.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                escrowed_amount,
            )?;
        }

        let now = Clock::get()?.unix_timestamp;
        let payment = &mut ctx.accounts.payment;
        payment.buyer = buyer_key;
        payment.merchant = merchant_key;
        payment.mint = mint_key;
        payment.order_id = order_id;
        payment.amount = amount;
        payment.instant_amount = instant_amount;
        payment.escrowed_amount = escrowed_amount;
        payment.fee_amount = 0;
        payment.status = PaymentStatus::EscrowHeld;
        payment.created_at = now;
        payment.expiry = now
            .checked_add(timeout_seconds)
            .ok_or(ErrorCode::ArithmeticOverflow)?;
        payment.claimed_at = 0;
        payment.bump = ctx.bumps.payment;
        payment.vault_bump = ctx.bumps.escrow_vault;

        emit!(PaymentInitiated {
            buyer: payment.buyer,
            merchant: payment.merchant,
            mint: payment.mint,
            order_id,
            amount,
            instant_amount,
            escrowed_amount,
            expiry: payment.expiry,
        });
        Ok(())
    }

    /// The buyer confirms the order arrived. Releases the escrowed portion
    /// to the merchant (less the settlement fee), unlocks the merchant's
    /// reserve exposure for this order, and raises the buyer's own standing.
    pub fn confirm_delivery(ctx: Context<ConfirmDelivery>, order_id: u64) -> Result<()> {
        require!(
            ctx.accounts.payment.status == PaymentStatus::EscrowHeld,
            ErrorCode::InvalidPaymentStatus
        );
        require!(ctx.accounts.payment.order_id == order_id, ErrorCode::InvalidOrder);

        settle_fulfilled(
            &ctx.accounts.token_program,
            &ctx.accounts.escrow_vault,
            &ctx.accounts.merchant_token,
            &ctx.accounts.treasury_token,
            &mut ctx.accounts.payment,
            ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.merchant_reserve,
            &ctx.accounts.buyer_standing,
            order_id,
        )
    }

    /// The merchant claims this order was fulfilled, without the buyer
    /// having confirmed. Starts the dispute window: if the buyer does not
    /// call `dispute_claim` before `CLAIM_DISPUTE_SECONDS` pass, anyone can
    /// call `finalize_claim` to settle it exactly as a confirmation would.
    /// Fixes the case where an honest merchant delivered but the buyer
    /// simply never returns to confirm.
    pub fn claim_fulfillment(ctx: Context<ClaimFulfillment>, order_id: u64) -> Result<()> {
        let payment = &mut ctx.accounts.payment;
        require!(
            payment.status == PaymentStatus::EscrowHeld,
            ErrorCode::InvalidPaymentStatus
        );
        require!(payment.order_id == order_id, ErrorCode::InvalidOrder);
        require!(payment.claimed_at == 0, ErrorCode::AlreadyClaimed);
        require!(
            Clock::get()?.unix_timestamp < payment.expiry,
            ErrorCode::ReclaimNotYetAvailable
        );

        payment.claimed_at = Clock::get()?.unix_timestamp;
        emit!(FulfillmentClaimed {
            buyer: payment.buyer,
            merchant: payment.merchant,
            order_id,
            claimed_at: payment.claimed_at,
        });
        Ok(())
    }

    /// The buyer disputes an active claim: it genuinely was not fulfilled.
    /// Clears the claim and falls back to the normal timeout path — the
    /// merchant may claim again if it believes otherwise, or the buyer
    /// reclaims at `expiry` as usual.
    pub fn dispute_claim(ctx: Context<DisputeClaim>, order_id: u64) -> Result<()> {
        let payment = &mut ctx.accounts.payment;
        require!(payment.order_id == order_id, ErrorCode::InvalidOrder);
        require!(payment.claimed_at != 0, ErrorCode::NoActiveClaim);
        payment.claimed_at = 0;
        emit!(ClaimDisputed {
            buyer: payment.buyer,
            merchant: payment.merchant,
            order_id,
        });
        Ok(())
    }

    /// Once an unopposed claim has sat for `CLAIM_DISPUTE_SECONDS`, settles
    /// the order exactly as `confirm_delivery` would. Anyone can call this —
    /// the dispute window, not a signature, is what protects the buyer.
    pub fn finalize_claim(ctx: Context<FinalizeClaim>, order_id: u64) -> Result<()> {
        require!(
            ctx.accounts.payment.status == PaymentStatus::EscrowHeld,
            ErrorCode::InvalidPaymentStatus
        );
        require!(ctx.accounts.payment.order_id == order_id, ErrorCode::InvalidOrder);
        require!(ctx.accounts.payment.claimed_at != 0, ErrorCode::NoActiveClaim);
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.payment.claimed_at + CLAIM_DISPUTE_SECONDS,
            ErrorCode::ClaimNotYetFinalizable
        );

        settle_fulfilled(
            &ctx.accounts.token_program,
            &ctx.accounts.escrow_vault,
            &ctx.accounts.merchant_token,
            &ctx.accounts.treasury_token,
            &mut ctx.accounts.payment,
            ctx.accounts.merchant.to_account_info(),
            &ctx.accounts.merchant_reserve,
            &ctx.accounts.buyer_standing,
            order_id,
        )
    }

    /// The merchant never delivered, and never successfully claimed to. The
    /// buyer takes the escrowed remainder back, and the merchant's own
    /// reserve is skimmed for up to the instant amount it was already
    /// paid — the buyer is made whole either way. No signature but the
    /// clock is required.
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

        let escrowed_amount = payment.escrowed_amount;
        let instant_amount = payment.instant_amount;
        let merchant = payment.merchant;

        release(
            &ctx.accounts.token_program,
            &ctx.accounts.escrow_vault,
            &ctx.accounts.buyer_token,
            &ctx.accounts.payment,
            ctx.accounts.buyer.to_account_info(),
            escrowed_amount,
            order_id,
        )?;

        if instant_amount > 0 {
            require!(
                *ctx.accounts.merchant_reserve.owner == crate::ID,
                ErrorCode::InvalidReserve
            );
            let mut reserve: MerchantReserve = read_account(&ctx.accounts.merchant_reserve)?;
            require!(reserve.merchant == merchant, ErrorCode::InvalidReserve);
            let vault: TokenAccount = read_account(&ctx.accounts.reserve_vault)?;
            require!(vault.owner == ctx.accounts.merchant_reserve.key(), ErrorCode::InvalidReserve);

            // Made whole up to whatever the reserve actually still holds —
            // a reserve already drained by other orders is a separate,
            // documented shortfall case, not solved here.
            let skimmed = instant_amount.min(vault.amount);
            if skimmed > 0 {
                let reserve_bump = reserve.bump;
                let signer_seeds: &[&[u8]] = &[b"reserve", merchant.as_ref(), &[reserve_bump]];
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.reserve_vault.to_account_info(),
                            to: ctx.accounts.buyer_token.to_account_info(),
                            authority: ctx.accounts.merchant_reserve.to_account_info(),
                        },
                        &[signer_seeds],
                    ),
                    skimmed,
                )?;
            }
            reserve.locked_exposure = reserve.locked_exposure.saturating_sub(instant_amount);
            write_account(&ctx.accounts.merchant_reserve, &reserve)?;

            emit!(ReserveSkimmed {
                merchant,
                order_id,
                skimmed,
            });
        }

        let payment = &mut ctx.accounts.payment;
        payment.status = PaymentStatus::Reclaimed;

        emit!(PaymentSettled {
            buyer: payment.buyer,
            merchant: payment.merchant,
            order_id,
            amount: payment.amount,
            fee: 0,
            outcome: PaymentStatus::Reclaimed,
        });
        Ok(())
    }

    /// Reclaims the rent of a finished Payment account.
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

/// Reads one of this program's own accounts straight off its raw bytes,
/// deliberately bypassing `Account::try_from`. `try_from` returns an
/// `Account<'info, T>`, which requires the reference passed to it to itself
/// live as long as that same `'info` — a bound nothing borrowed out of a
/// `Context` inside a handler body can ever actually satisfy, since `ctx`
/// only lives for the handler's own call. Deserializing straight into a
/// plain, lifetime-free `T` sidesteps the requirement instead of fighting it.
fn read_account<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    let data = info.try_borrow_data()?;
    T::try_deserialize(&mut &data[..])
}

/// The write-back half of `read_account`: re-serializes in place over the
/// account's existing bytes. Only ever used on accounts whose size never
/// changes after `init`, so there is no reallocation to handle.
fn write_account<T: AccountSerialize>(info: &AccountInfo, account: &T) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut cursor = std::io::Cursor::new(&mut data[..]);
    account.try_serialize(&mut cursor)
}

/// Shared by `confirm_delivery` and `finalize_claim`: release the escrowed
/// portion (less the settlement fee, charged only on the escrowed portion —
/// see `FEE_BPS`) to the merchant, unlock the merchant's reserve exposure
/// for this order, and raise the buyer's standing if it has ever been
/// opened.
fn settle_fulfilled<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    merchant_token: &Account<'info, TokenAccount>,
    treasury_token: &Account<'info, TokenAccount>,
    payment: &mut Account<'info, Payment>,
    rent_destination: AccountInfo<'info>,
    merchant_reserve: &AccountInfo<'info>,
    buyer_standing: &AccountInfo<'info>,
    order_id: u64,
) -> Result<()> {
    let escrowed_amount = payment.escrowed_amount;
    let instant_amount = payment.instant_amount;
    let fee = settlement_fee(escrowed_amount)?;
    let to_merchant = escrowed_amount
        .checked_sub(fee)
        .ok_or(ErrorCode::ArithmeticOverflow)?;

    take_fee(token_program, vault, treasury_token, payment, fee, order_id)?;
    release(
        token_program,
        vault,
        merchant_token,
        payment,
        rent_destination,
        to_merchant,
        order_id,
    )?;

    if instant_amount > 0 && *merchant_reserve.owner == crate::ID {
        let mut reserve: MerchantReserve = read_account(merchant_reserve)?;
        if reserve.merchant == payment.merchant {
            reserve.locked_exposure = reserve.locked_exposure.saturating_sub(instant_amount);
            write_account(merchant_reserve, &reserve)?;
        }
    }

    if *buyer_standing.owner == crate::ID {
        let mut standing: BuyerStanding = read_account(buyer_standing)?;
        if standing.buyer == payment.buyer {
            standing.settled_count = standing.settled_count.saturating_add(1);
            write_account(buyer_standing, &standing)?;
        }
    }

    payment.status = PaymentStatus::Settled;
    payment.fee_amount = fee;

    emit!(PaymentSettled {
        buyer: payment.buyer,
        merchant: payment.merchant,
        order_id,
        amount: payment.amount,
        fee,
        outcome: PaymentStatus::Settled,
    });
    Ok(())
}

/// Moves `amount` out of the vault and closes it, signing as the Payment
/// PDA. Every release in this program goes through here.
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

/// Moves the settlement fee out of the vault, leaving the rest for the
/// merchant. Kept separate from `release` because `release` also closes the
/// vault, and the fee has to be paid while it is still open.
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

/// The settlement fee for an order's escrowed portion. Rounds down.
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
    /// The full order price.
    pub amount: u64,
    /// The slice of `amount` paid straight to the merchant at initiation.
    pub instant_amount: u64,
    /// The slice of `amount` held in the vault. `amount == instant_amount +
    /// escrowed_amount` always.
    pub escrowed_amount: u64,
    /// The settlement fee actually charged, on the escrowed portion only.
    /// Zero until the order settles.
    pub fee_amount: u64,
    pub status: PaymentStatus,
    pub created_at: i64,
    /// Reclaim becomes available at this unix timestamp.
    pub expiry: i64,
    /// Unix timestamp of an active, unopposed `claim_fulfillment`. Zero
    /// means no active claim.
    pub claimed_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum PaymentStatus {
    EscrowHeld,
    Settled,
    Reclaimed,
}

/// A merchant's posted collateral. Its real funds live in the paired
/// `reserve_vault` token account; this record only tracks how much of that
/// balance is currently locked, backing outstanding instant payments.
#[account]
#[derive(InitSpace)]
pub struct MerchantReserve {
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub locked_exposure: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

/// A buyer's history. The only thing this is used for is gating instant-
/// payment eligibility on future orders — never a trust or fraud score.
#[account]
#[derive(InitSpace)]
pub struct BuyerStanding {
    pub buyer: Pubkey,
    pub settled_count: u32,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct PaymentInitiated {
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub order_id: u64,
    pub amount: u64,
    pub instant_amount: u64,
    pub escrowed_amount: u64,
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

#[event]
pub struct FulfillmentClaimed {
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    pub order_id: u64,
    pub claimed_at: i64,
}

#[event]
pub struct ClaimDisputed {
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    pub order_id: u64,
}

#[event]
pub struct ReserveOpened {
    pub merchant: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct ReservePosted {
    pub merchant: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ReserveWithdrawn {
    pub merchant: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ReserveSkimmed {
    pub merchant: Pubkey,
    pub order_id: u64,
    pub skimmed: u64,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct OpenReserve<'info> {
    #[account(
        init,
        payer = merchant,
        space = 8 + MerchantReserve::INIT_SPACE,
        seeds = [b"reserve", merchant.key().as_ref()],
        bump
    )]
    pub reserve: Box<Account<'info, MerchantReserve>>,

    #[account(mut)]
    pub merchant: Signer<'info>,

    #[account(
        init,
        payer = merchant,
        seeds = [b"reserve_vault", reserve.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = reserve,
    )]
    pub reserve_vault: Box<Account<'info, TokenAccount>>,

    pub mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct PostReserve<'info> {
    #[account(
        seeds = [b"reserve", merchant.key().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Box<Account<'info, MerchantReserve>>,

    pub merchant: Signer<'info>,

    #[account(
        mut,
        seeds = [b"reserve_vault", reserve.key().as_ref()],
        bump = reserve.vault_bump,
    )]
    pub reserve_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = merchant_token.owner == merchant.key() @ ErrorCode::InvalidTokenOwner,
        constraint = merchant_token.mint == reserve.mint @ ErrorCode::InvalidMint,
    )]
    pub merchant_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawReserve<'info> {
    #[account(
        seeds = [b"reserve", merchant.key().as_ref()],
        bump = reserve.bump,
    )]
    pub reserve: Box<Account<'info, MerchantReserve>>,

    pub merchant: Signer<'info>,

    #[account(
        mut,
        seeds = [b"reserve_vault", reserve.key().as_ref()],
        bump = reserve.vault_bump,
    )]
    pub reserve_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = merchant_token.owner == merchant.key() @ ErrorCode::InvalidTokenOwner,
        constraint = merchant_token.mint == reserve.mint @ ErrorCode::InvalidMint,
    )]
    pub merchant_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RegisterBuyer<'info> {
    #[account(
        init,
        payer = buyer,
        space = 8 + BuyerStanding::INIT_SPACE,
        seeds = [b"standing", buyer.key().as_ref()],
        bump
    )]
    pub standing: Box<Account<'info, BuyerStanding>>,

    #[account(mut)]
    pub buyer: Signer<'info>,

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
    pub payment: Box<Account<'info, Payment>>,

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
        mut,
        constraint = merchant_token.owner == merchant.key() @ ErrorCode::InvalidTokenOwner,
        constraint = merchant_token.mint == mint.key() @ ErrorCode::InvalidMint,
    )]
    pub merchant_token: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = buyer,
        seeds = [b"vault", payment.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = payment,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: may or may not exist yet. Read manually — see
    /// `initiate_payment`'s body — because a merchant is not required to
    /// have opened a reserve to receive payment at all, only to be eligible
    /// for the instant portion.
    #[account(mut, seeds = [b"reserve", merchant.key().as_ref()], bump)]
    pub merchant_reserve: AccountInfo<'info>,

    /// CHECK: the reserve's vault, only read when `merchant_reserve` exists.
    pub reserve_vault: AccountInfo<'info>,

    /// CHECK: may or may not exist yet — see `merchant_reserve` above, same
    /// reasoning for the buyer's own standing.
    #[account(seeds = [b"standing", buyer.key().as_ref()], bump)]
    pub buyer_standing: AccountInfo<'info>,

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

    #[account(
        mut,
        constraint = treasury_token.owner == TREASURY @ ErrorCode::InvalidTreasury,
        constraint = treasury_token.mint == payment.mint @ ErrorCode::InvalidMint,
    )]
    pub treasury_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: only touched if `payment.instant_amount > 0`, in which case it
    /// is guaranteed to already exist.
    #[account(mut, seeds = [b"reserve", payment.merchant.as_ref()], bump)]
    pub merchant_reserve: AccountInfo<'info>,

    /// CHECK: only touched if it already exists — see `register_buyer`.
    #[account(mut, seeds = [b"standing", buyer.key().as_ref()], bump)]
    pub buyer_standing: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct ClaimFulfillment<'info> {
    #[account(
        mut,
        seeds = [b"payment", payment.buyer.as_ref(), merchant.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump = payment.bump,
    )]
    pub payment: Box<Account<'info, Payment>>,

    #[account(constraint = merchant.key() == payment.merchant @ ErrorCode::InvalidMerchant)]
    pub merchant: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct DisputeClaim<'info> {
    #[account(
        mut,
        seeds = [b"payment", buyer.key().as_ref(), payment.merchant.as_ref(), order_id.to_le_bytes().as_ref()],
        bump = payment.bump,
    )]
    pub payment: Box<Account<'info, Payment>>,

    #[account(constraint = buyer.key() == payment.buyer @ ErrorCode::InvalidBuyer)]
    pub buyer: Signer<'info>,
}

/// Fixed accounts for `finalize_claim`. No signer required beyond whoever
/// pays this transaction's own network fee — the dispute window already
/// closing is the authorization.
#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct FinalizeClaim<'info> {
    #[account(
        mut,
        seeds = [b"payment", payment.buyer.as_ref(), payment.merchant.as_ref(), order_id.to_le_bytes().as_ref()],
        bump = payment.bump,
    )]
    pub payment: Box<Account<'info, Payment>>,

    #[account(
        mut,
        seeds = [b"vault", payment.key().as_ref()],
        bump = payment.vault_bump,
    )]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: the merchant being paid; only used as a rent destination and
    /// for the merchant_token/reserve constraints below.
    #[account(mut, constraint = merchant.key() == payment.merchant @ ErrorCode::InvalidMerchant)]
    pub merchant: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = merchant_token.owner == payment.merchant @ ErrorCode::InvalidTokenOwner,
        constraint = merchant_token.mint == payment.mint @ ErrorCode::InvalidMint,
    )]
    pub merchant_token: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = treasury_token.owner == TREASURY @ ErrorCode::InvalidTreasury,
        constraint = treasury_token.mint == payment.mint @ ErrorCode::InvalidMint,
    )]
    pub treasury_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: only touched if `payment.instant_amount > 0`.
    #[account(mut, seeds = [b"reserve", payment.merchant.as_ref()], bump)]
    pub merchant_reserve: AccountInfo<'info>,

    /// CHECK: only touched if it already exists.
    #[account(mut, seeds = [b"standing", payment.buyer.as_ref()], bump)]
    pub buyer_standing: AccountInfo<'info>,

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

    /// CHECK: only touched if `payment.instant_amount > 0`.
    #[account(mut, seeds = [b"reserve", payment.merchant.as_ref()], bump)]
    pub merchant_reserve: AccountInfo<'info>,

    /// CHECK: only touched if `payment.instant_amount > 0`.
    #[account(mut)]
    pub reserve_vault: AccountInfo<'info>,

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
    #[msg("Reserve account does not match the expected merchant, mint, or vault")]
    InvalidReserve,
    #[msg("Withdrawal exceeds the reserve's currently-available (unlocked) balance")]
    InsufficientReserve,
    #[msg("Standing account does not match the expected buyer")]
    InvalidStanding,
    #[msg("This order already has an active fulfillment claim")]
    AlreadyClaimed,
    #[msg("This order has no active fulfillment claim")]
    NoActiveClaim,
    #[msg("The claim's dispute window has not yet elapsed")]
    ClaimNotYetFinalizable,
}
