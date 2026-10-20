use anchor_lang::prelude::*;
use crate::constants::VAULT_SEED;
use crate::state::Vault;

#[derive(Accounts)]
pub struct ManageVault<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct RotateAgent<'info> {
    pub owner: Signer<'info>,

    /// CHECK: New agent pubkey
    pub new_agent: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, Vault>,
}

pub fn pause_vault_handler(ctx: Context<ManageVault>) -> Result<()> {
    ctx.accounts.vault.is_paused = true;
    Ok(())
}

pub fn unpause_vault_handler(ctx: Context<ManageVault>) -> Result<()> {
    ctx.accounts.vault.is_paused = false;
    Ok(())
}

pub fn rotate_agent_handler(ctx: Context<RotateAgent>) -> Result<()> {
    ctx.accounts.vault.agent = ctx.accounts.new_agent.key();
    Ok(())
}
