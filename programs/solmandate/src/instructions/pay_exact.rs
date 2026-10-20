use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use crate::constants::{TOKEN_VAULT_SEED, VAULT_SEED};
use crate::error::SolMandateError;
use crate::state::{Mandate, Vault};

#[derive(Accounts)]
pub struct PayExact<'info> {
    pub agent: Signer<'info>,

    #[account(
        has_one = agent,
        has_one = token_mint,
        has_one = token_vault,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        has_one = vault,
    )]
    pub mandate: Account<'info, Mandate>,

    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [TOKEN_VAULT_SEED, vault.key().as_ref()],
        bump = vault.vault_bump,
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Merchant recipient address
    pub merchant: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = merchant,
    )]
    pub merchant_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn pay_exact_handler(ctx: Context<PayExact>, amount: u64) -> Result<()> {
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

    // 5. Approval threshold check (cannot bypass threshold via pay_exact)
    if mandate.approval_threshold > 0 {
        require!(amount < mandate.approval_threshold, SolMandateError::RequiresApproval);
    }

    // 6. Merchant allowlist check
    require!(mandate.is_merchant_allowed(&ctx.accounts.merchant.key()), SolMandateError::MerchantNotAllowed);

    // 7. Budget check
    let available = mandate.available_budget().ok_or(SolMandateError::ArithmeticOverflow)?;
    require!(amount <= available, SolMandateError::BudgetExceeded);

    // Update state
    mandate.settled_amount = mandate.settled_amount.checked_add(amount).ok_or(SolMandateError::ArithmeticOverflow)?;
    mandate.purchase_count = mandate.purchase_count.checked_add(1).ok_or(SolMandateError::ArithmeticOverflow)?;

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
    let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer);
    token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.token_mint.decimals)?;

    Ok(())
}
