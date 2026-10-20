use anchor_lang::prelude::*;
use crate::constants::{MANDATE_SEED, VAULT_SEED};
use crate::state::{Mandate, Vault};

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CreateMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,

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
    let mandate = &mut ctx.accounts.mandate;
    mandate.vault = ctx.accounts.vault.key();
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
