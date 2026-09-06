use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("11111111111111111111111111111111");

#[program]
pub mod x402_scoring {
    use super::*;

    pub fn register_merchant(ctx: Context<RegisterMerchant>, _bump: u8) -> Result<()> {
        let merchant = &mut ctx.accounts.merchant;
        merchant.address = ctx.accounts.owner.key();
        merchant.tier = MerchantTier::Low;
        merchant.total_payments = 0;
        merchant.successful_deliveries = 0;
        merchant.escrow_balance = 0;
        Ok(())
    }

    pub fn update_merchant_tier(
        ctx: Context<UpdateMerchantTier>,
        new_tier: u8,
    ) -> Result<()> {
        let merchant = &mut ctx.accounts.merchant;
        require!(merchant.address == ctx.accounts.owner.key(), InvalidMerchant);

        merchant.tier = match new_tier {
            0 => MerchantTier::Low,
            1 => MerchantTier::High,
            _ => return Err(error!(ErrorCode::InvalidTier)),
        };

        Ok(())
    }

    pub fn initiate_payment(
        ctx: Context<InitiatePayment>,
        amount: u64,
        order_id: u64,
    ) -> Result<()> {
        let payment = &mut ctx.accounts.payment;
        payment.buyer = ctx.accounts.buyer.key();
        payment.merchant = ctx.accounts.merchant.key();
        payment.amount = amount;
        payment.order_id = order_id;
        payment.status = PaymentStatus::Pending;
        payment.created_at = Clock::get()?.unix_timestamp;

        match ctx.accounts.merchant.tier {
            MerchantTier::Low => {
                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.buyer_token.to_account_info(),
                            to: ctx.accounts.escrow_token.to_account_info(),
                            authority: ctx.accounts.buyer.to_account_info(),
                        },
                    ),
                    amount,
                )?;

                payment.status = PaymentStatus::EscrowHeld;
                ctx.accounts.merchant.escrow_balance = ctx
                    .accounts
                    .merchant
                    .escrow_balance
                    .checked_add(amount)
                    .ok_or(ErrorCode::ArithmeticOverflow)?;
            }
            MerchantTier::High => {
                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.buyer_token.to_account_info(),
                            to: ctx.accounts.merchant_token.to_account_info(),
                            authority: ctx.accounts.buyer.to_account_info(),
                        },
                    ),
                    amount,
                )?;

                payment.status = PaymentStatus::Settled;
                ctx.accounts.merchant.total_payments = ctx
                    .accounts
                    .merchant
                    .total_payments
                    .checked_add(1)
                    .ok_or(ErrorCode::ArithmeticOverflow)?;
            }
        }

        Ok(())
    }

    pub fn confirm_delivery(ctx: Context<ConfirmDelivery>, order_id: u64) -> Result<()> {
        let payment = &mut ctx.accounts.payment;

        require!(payment.status == PaymentStatus::EscrowHeld, InvalidPaymentStatus);
        require!(payment.order_id == order_id, InvalidOrder);
        require!(payment.buyer == ctx.accounts.buyer.key(), Unauthorized);

        let amount = payment.amount;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_token.to_account_info(),
                    to: ctx.accounts.merchant_token.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
            ),
            amount,
        )?;

        payment.status = PaymentStatus::Settled;

        ctx.accounts.merchant.escrow_balance = ctx
            .accounts
            .merchant
            .escrow_balance
            .checked_sub(amount)
            .ok_or(ErrorCode::ArithmeticUnderflow)?;

        ctx.accounts.merchant.successful_deliveries = ctx
            .accounts
            .merchant
            .successful_deliveries
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        ctx.accounts.merchant.total_payments = ctx
            .accounts
            .merchant
            .total_payments
            .checked_add(1)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        Ok(())
    }

    pub fn refund_escrow(ctx: Context<RefundEscrow>, order_id: u64) -> Result<()> {
        let payment = &mut ctx.accounts.payment;

        require!(payment.status == PaymentStatus::EscrowHeld, InvalidPaymentStatus);
        require!(payment.order_id == order_id, InvalidOrder);
        require!(payment.buyer == ctx.accounts.buyer.key(), Unauthorized);

        let amount = payment.amount;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_token.to_account_info(),
                    to: ctx.accounts.buyer_token.to_account_info(),
                    authority: ctx.accounts.escrow_authority.to_account_info(),
                },
            ),
            amount,
        )?;

        payment.status = PaymentStatus::Refunded;

        ctx.accounts.merchant.escrow_balance = ctx
            .accounts
            .merchant
            .escrow_balance
            .checked_sub(amount)
            .ok_or(ErrorCode::ArithmeticUnderflow)?;

        Ok(())
    }
}

#[derive(InitSpace)]
#[account]
pub struct Merchant {
    pub address: Pubkey,
    pub tier: MerchantTier,
    pub total_payments: u64,
    pub successful_deliveries: u64,
    pub escrow_balance: u64,
}

#[derive(InitSpace)]
#[account]
pub struct Payment {
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub order_id: u64,
    pub status: PaymentStatus,
    pub created_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq)]
pub enum MerchantTier {
    Low,
    High,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq)]
pub enum PaymentStatus {
    Pending,
    EscrowHeld,
    Settled,
    Refunded,
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
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateMerchantTier<'info> {
    #[account(mut)]
    pub merchant: Account<'info, Merchant>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitiatePayment<'info> {
    #[account(
        init,
        payer = buyer,
        space = 8 + Payment::INIT_SPACE,
        seeds = [b"payment", buyer.key().as_ref(), merchant.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump
    )]
    pub payment: Account<'info, Payment>,
    #[account(mut)]
    pub merchant: Account<'info, Merchant>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub buyer_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub merchant_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub escrow_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct ConfirmDelivery<'info> {
    #[account(mut, seeds = [b"payment", buyer.key().as_ref(), merchant.key().as_ref(), order_id.to_le_bytes().as_ref()], bump)]
    pub payment: Account<'info, Payment>,
    #[account(mut)]
    pub merchant: Account<'info, Merchant>,
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub escrow_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub merchant_token: Account<'info, TokenAccount>,
    pub escrow_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct RefundEscrow<'info> {
    #[account(mut, seeds = [b"payment", buyer.key().as_ref(), merchant.key().as_ref(), order_id.to_le_bytes().as_ref()], bump)]
    pub payment: Account<'info, Payment>,
    #[account(mut)]
    pub merchant: Account<'info, Merchant>,
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub escrow_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub buyer_token: Account<'info, TokenAccount>,
    pub escrow_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid merchant account")]
    InvalidMerchant,
    #[msg("Invalid tier value")]
    InvalidTier,
    #[msg("Invalid payment status")]
    InvalidPaymentStatus,
    #[msg("Invalid order ID")]
    InvalidOrder,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Arithmetic underflow")]
    ArithmeticUnderflow,
}
