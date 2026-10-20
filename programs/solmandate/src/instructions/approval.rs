use anchor_lang::prelude::*;
use crate::constants::{ESCROW_SEED, PENDING_SEED, VAULT_SEED};
use crate::error::SolMandateError;
use crate::state::{Escrow, EscrowState, Mandate, PendingApproval, Vault};

#[derive(Accounts)]
pub struct ApproveRequest<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        has_one = vault,
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        mut,
        has_one = mandate,
        close = owner,
        seeds = [PENDING_SEED, mandate.key().as_ref(), pending_approval.payment_id.as_ref()],
        bump = pending_approval.bump,
    )]
    pub pending_approval: Account<'info, PendingApproval>,

    #[account(
        init,
        payer = owner,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, mandate.key().as_ref(), pending_approval.payment_id.as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RejectRequest<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        has_one = owner,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        has_one = vault,
    )]
    pub mandate: Account<'info, Mandate>,

    #[account(
        mut,
        has_one = mandate,
        close = owner,
        seeds = [PENDING_SEED, mandate.key().as_ref(), pending_approval.payment_id.as_ref()],
        bump = pending_approval.bump,
    )]
    pub pending_approval: Account<'info, PendingApproval>,
}

pub fn approve_request_handler(ctx: Context<ApproveRequest>, deadline: i64) -> Result<()> {
    let mandate = &mut ctx.accounts.mandate;
    let pending = &ctx.accounts.pending_approval;
    let clock = Clock::get()?;

    require!(clock.unix_timestamp <= pending.expires_at, SolMandateError::DeadlinePassed);

    let available = mandate.available_budget().ok_or(SolMandateError::ArithmeticOverflow)?;
    require!(pending.amount <= available, SolMandateError::BudgetExceeded);

    mandate.reserved_amount = mandate.reserved_amount.checked_add(pending.amount).ok_or(SolMandateError::ArithmeticOverflow)?;
    mandate.purchase_count = mandate.purchase_count.checked_add(1).ok_or(SolMandateError::ArithmeticOverflow)?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.payment_id = pending.payment_id;
    escrow.mandate = mandate.key();
    escrow.merchant = pending.merchant;
    escrow.amount = pending.amount;
    escrow.offer_hash = pending.offer_hash;
    escrow.delivery_hash = [0u8; 32];
    escrow.deadline = deadline;
    escrow.state = EscrowState::Held;
    escrow.bump = ctx.bumps.escrow;

    Ok(())
}

pub fn reject_request_handler(_ctx: Context<RejectRequest>) -> Result<()> {
    // PendingApproval account closed, rent refunded to owner
    Ok(())
}
