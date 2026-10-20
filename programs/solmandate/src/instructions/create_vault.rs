use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use crate::constants::{VAULT_SEED, TOKEN_VAULT_SEED};
use crate::state::Vault;

#[derive(Accounts)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: Designated authorized agent
    pub agent: UncheckedAccount<'info>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        init,
        payer = owner,
        token::mint = token_mint,
        token::authority = vault,
        seeds = [TOKEN_VAULT_SEED, vault.key().as_ref()],
        bump,
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn create_vault_handler(ctx: Context<CreateVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.owner.key();
    vault.agent = ctx.accounts.agent.key();
    vault.token_mint = ctx.accounts.token_mint.key();
    vault.token_vault = ctx.accounts.token_vault.key();
    vault.is_paused = false;
    vault.bump = ctx.bumps.vault;
    vault.vault_bump = ctx.bumps.token_vault;
    Ok(())
}
