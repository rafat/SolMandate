use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;
use crate::constants::{MANDATE_SEED, TOKEN_VAULT_SEED, VAULT_SEED};
use crate::error::SolMandateError;
use crate::state::{Mandate, Vault};

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CreateMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        seeds = [TOKEN_VAULT_SEED, vault.key().as_ref()],
        bump = vault.vault_bump,
        constraint = token_vault.key() == vault.token_vault @ SolMandateError::InvalidParameter,
        constraint = token_vault.mint == vault.token_mint @ SolMandateError::InvalidParameter,
        constraint = token_vault.owner == vault.key() @ SolMandateError::InvalidParameter,
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = owner,
        space = 8 + Mandate::INIT_SPACE,
        seeds = [MANDATE_SEED, vault.key().as_ref(), task_id.as_ref()],
        bump,
    )]
    pub mandate: Account<'info, Mandate>,

    pub system_program: Program<'info, System>,
}

pub fn create_mandate_handler(
    ctx: Context<CreateMandate>,
    task_id: [u8; 32],
    total_budget: u64,
    max_payment_amount: u64,
    max_purchases: u32,
    approval_threshold: u64,
    expires_at: i64,
    merchant_allowlist: Vec<Pubkey>,
) -> Result<()> {
    // 1. Input validations
    require!(total_budget > 0, SolMandateError::InvalidAmount);
    require!(
        max_payment_amount > 0 && max_payment_amount <= total_budget,
        SolMandateError::InvalidAmount
    );
    require!(max_purchases > 0, SolMandateError::InvalidParameter);
    let clock = Clock::get()?;
    require!(expires_at > clock.unix_timestamp, SolMandateError::MandateExpired);
    require!(merchant_allowlist.len() <= 16, SolMandateError::AllowlistExceeded);

    // Reject duplicate entries in allowlist
    let mut deduplicated = merchant_allowlist.clone();
    deduplicated.sort();
    deduplicated.dedup();
    require!(deduplicated.len() == merchant_allowlist.len(), SolMandateError::InvalidParameter);

    // 2. Vault liability accounting check
    let vault = &mut ctx.accounts.vault;
    let token_vault_balance = ctx.accounts.token_vault.amount;
    let required_vault_balance = vault
        .allocated_budget
        .checked_add(total_budget)
        .ok_or(SolMandateError::ArithmeticOverflow)?;

    require!(
        token_vault_balance >= required_vault_balance,
        SolMandateError::VaultOvercommitted
    );

    // 3. Update vault allocated liabilities
    vault.allocated_budget = required_vault_balance;

    // 4. Initialize mandate
    let mandate = &mut ctx.accounts.mandate;
    mandate.vault = vault.key();
    mandate.task_id = task_id;
    mandate.total_budget = total_budget;
    mandate.reserved_amount = 0;
    mandate.settled_amount = 0;
    mandate.max_payment_amount = max_payment_amount;
    mandate.max_purchases = max_purchases;
    mandate.purchase_count = 0;
    mandate.approval_threshold = approval_threshold;
    mandate.expires_at = expires_at;
    mandate.merchant_allowlist = merchant_allowlist;
    mandate.bump = ctx.bumps.mandate;
    Ok(())
}
