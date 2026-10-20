use anchor_lang::prelude::*;
use crate::constants::{ESCROW_SEED, PENDING_SEED};
use crate::error::SolMandateError;
use crate::state::{Escrow, EscrowState, Mandate, PendingApproval, Vault};

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct RequestPayment<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(
        has_one = agent,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        has_one = vault,
    )]
    pub mandate: Account<'info, Mandate>,

    /// CHECK: Merchant recipient address
    pub merchant: UncheckedAccount<'info>,

    #[account(
        init,
        payer = agent,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, mandate.key().as_ref(), payment_id.as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct RequestApproval<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,

    #[account(
        has_one = agent,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        has_one = vault,
    )]
    pub mandate: Account<'info, Mandate>,

    /// CHECK: Merchant recipient address
    pub merchant: UncheckedAccount<'info>,

    #[account(
        init,
        payer = agent,
        space = 8 + PendingApproval::INIT_SPACE,
        seeds = [PENDING_SEED, mandate.key().as_ref(), payment_id.as_ref()],
        bump,
    )]
    pub pending_approval: Account<'info, PendingApproval>,

    pub system_program: Program<'info, System>,
}

pub fn request_payment_handler(
    ctx: Context<RequestPayment>,
    payment_id: [u8; 32],
    amount: u64,
    offer_hash: [u8; 32],
    deadline: i64,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let mandate = &mut ctx.accounts.mandate;
    let clock = Clock::get()?;

    // 1. Vault pause check
    require!(!vault.is_paused, SolMandateError::VaultPaused);

    // 2. Expiry check
    require!(clock.unix_timestamp <= mandate.expires_at, SolMandateError::MandateExpired);

    // 3. Purchase count check
    require!(mandate.purchase_count < mandate.max_purchases, SolMandateError::MaxPurchasesExceeded);

    // 4. Per-payment cap check
    require!(amount <= mandate.max_payment_amount, SolMandateError::PaymentCapExceeded);

    // 5. Approval threshold check
    if mandate.approval_threshold > 0 {
        require!(amount < mandate.approval_threshold, SolMandateError::RequiresApproval);
    }

    // 6. Merchant allowlist check
    require!(mandate.is_merchant_allowed(&ctx.accounts.merchant.key()), SolMandateError::MerchantNotAllowed);

    // 7. Budget check
    let available = mandate.available_budget().ok_or(SolMandateError::ArithmeticOverflow)?;
    require!(amount <= available, SolMandateError::BudgetExceeded);

    // Update mandate reservations
    mandate.reserved_amount = mandate.reserved_amount.checked_add(amount).ok_or(SolMandateError::ArithmeticOverflow)?;
    mandate.purchase_count = mandate.purchase_count.checked_add(1).ok_or(SolMandateError::ArithmeticOverflow)?;

    // Initialize escrow
    let escrow = &mut ctx.accounts.escrow;
    escrow.payment_id = payment_id;
    escrow.mandate = mandate.key();
    escrow.merchant = ctx.accounts.merchant.key();
    escrow.amount = amount;
    escrow.offer_hash = offer_hash;
    escrow.delivery_hash = [0u8; 32];
    escrow.deadline = deadline;
    escrow.state = EscrowState::Held;
    escrow.bump = ctx.bumps.escrow;

    Ok(())
}

pub fn request_approval_handler(
    ctx: Context<RequestApproval>,
    payment_id: [u8; 32],
    amount: u64,
    offer_hash: [u8; 32],
    expires_at: i64,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let mandate = &ctx.accounts.mandate;
    let clock = Clock::get()?;

    require!(!vault.is_paused, SolMandateError::VaultPaused);
    require!(clock.unix_timestamp <= mandate.expires_at, SolMandateError::MandateExpired);
    require!(mandate.purchase_count < mandate.max_purchases, SolMandateError::MaxPurchasesExceeded);
    require!(mandate.is_merchant_allowed(&ctx.accounts.merchant.key()), SolMandateError::MerchantNotAllowed);

    let available = mandate.available_budget().ok_or(SolMandateError::ArithmeticOverflow)?;
    require!(amount <= available, SolMandateError::BudgetExceeded);

    let pending = &mut ctx.accounts.pending_approval;
    pending.payment_id = payment_id;
    pending.mandate = mandate.key();
    pending.merchant = ctx.accounts.merchant.key();
    pending.amount = amount;
    pending.offer_hash = offer_hash;
    pending.requested_at = clock.unix_timestamp;
    pending.expires_at = expires_at;
    pending.bump = ctx.bumps.pending_approval;

    Ok(())
}
