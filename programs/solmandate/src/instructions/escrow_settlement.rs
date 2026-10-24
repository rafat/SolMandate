use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use crate::constants::{TOKEN_VAULT_SEED, VAULT_SEED};
use crate::error::SolMandateError;
use crate::state::{Escrow, EscrowState, Mandate, Vault};

#[derive(Accounts)]
pub struct CommitDelivery<'info> {
    pub merchant: Signer<'info>,

    #[account(
        mut,
        has_one = merchant,
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct ReleasePayment<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = token_mint,
        has_one = token_vault,
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
    )]
    pub escrow: Account<'info, Escrow>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [TOKEN_VAULT_SEED, vault.key().as_ref()],
        bump = vault.vault_bump,
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Merchant recipient
    #[account(
        address = escrow.merchant
    )]
    pub merchant: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = merchant,
    )]
    pub merchant_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RefundPayment<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = token_vault,
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
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        mut,
        seeds = [TOKEN_VAULT_SEED, vault.key().as_ref()],
        bump = vault.vault_bump,
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
}

pub fn commit_delivery_handler(ctx: Context<CommitDelivery>, delivery_hash: [u8; 32]) -> Result<()> {
    require!(delivery_hash != [0u8; 32], SolMandateError::MissingDeliveryCommitment);

    let escrow = &mut ctx.accounts.escrow;
    require!(escrow.state == EscrowState::Held, SolMandateError::InvalidEscrowState);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp <= escrow.deadline, SolMandateError::DeadlinePassed);

    escrow.delivery_hash = delivery_hash;
    escrow.state = EscrowState::Delivered;
    Ok(())
}

pub fn release_payment_handler(ctx: Context<ReleasePayment>, delivered_hash: [u8; 32]) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let vault = &ctx.accounts.vault;
    require!(authority == vault.agent || authority == vault.owner, SolMandateError::Unauthorized);

    let escrow = &mut ctx.accounts.escrow;
    require!(
        escrow.state == EscrowState::Delivered,
        SolMandateError::InvalidEscrowState
    );
    require!(
        escrow.delivery_hash != [0u8; 32],
        SolMandateError::MissingDeliveryCommitment
    );
    require!(
        delivered_hash == escrow.delivery_hash,
        SolMandateError::DeliveryHashMismatch
    );

    let mandate = &mut ctx.accounts.mandate;
    mandate.reserved_amount = mandate.reserved_amount.checked_sub(escrow.amount).ok_or(SolMandateError::ArithmeticOverflow)?;
    mandate.settled_amount = mandate.settled_amount.checked_add(escrow.amount).ok_or(SolMandateError::ArithmeticOverflow)?;

    let vault = &mut ctx.accounts.vault;
    vault.allocated_budget = vault.allocated_budget.checked_sub(escrow.amount).ok_or(SolMandateError::ArithmeticOverflow)?;

    escrow.state = EscrowState::Released;

    // CPI transfer from vault to merchant
    let owner_key = vault.owner;
    let seeds = &[
        VAULT_SEED,
        owner_key.as_ref(),
        &[vault.bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.token_vault.to_account_info(),
        mint: ctx.accounts.token_mint.to_account_info(),
        to: ctx.accounts.merchant_token_account.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer);
    token_interface::transfer_checked(cpi_ctx, escrow.amount, ctx.accounts.token_mint.decimals)?;

    Ok(())
}

pub fn refund_payment_handler(ctx: Context<RefundPayment>) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let vault = &ctx.accounts.vault;
    let escrow = &mut ctx.accounts.escrow;

    // Refund requires authorization from merchant or owner
    require!(
        authority == escrow.merchant || authority == vault.owner,
        SolMandateError::Unauthorized
    );
    require!(
        escrow.state == EscrowState::Held || escrow.state == EscrowState::Delivered,
        SolMandateError::InvalidEscrowState
    );

    let mandate = &mut ctx.accounts.mandate;
    // Restore reserved funds back to available budget!
    mandate.reserved_amount = mandate.reserved_amount.checked_sub(escrow.amount).ok_or(SolMandateError::ArithmeticOverflow)?;

    escrow.state = EscrowState::Refunded;
    Ok(())
}

pub fn claim_after_timeout_handler(ctx: Context<RefundPayment>) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let vault = &ctx.accounts.vault;
    let escrow = &mut ctx.accounts.escrow;
    let clock = Clock::get()?;

    require!(authority == vault.agent || authority == vault.owner, SolMandateError::Unauthorized);
    require!(
        escrow.state == EscrowState::Held,
        SolMandateError::InvalidEscrowState
    );
    require!(clock.unix_timestamp > escrow.deadline, SolMandateError::TimeoutNotReached);

    let mandate = &mut ctx.accounts.mandate;
    mandate.reserved_amount = mandate.reserved_amount.checked_sub(escrow.amount).ok_or(SolMandateError::ArithmeticOverflow)?;

    escrow.state = EscrowState::Refunded;
    Ok(())
}
