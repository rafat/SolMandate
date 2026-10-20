pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("CBuziEesW1tEjs1vbY6pnXVRMzmqwvjuEJty8UQdCyD8");

#[program]
pub mod solmandate {
    use super::*;

    pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
        instructions::create_vault_handler(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit_handler(ctx, amount)
    }

    pub fn pause_vault(ctx: Context<ManageVault>) -> Result<()> {
        instructions::pause_vault_handler(ctx)
    }

    pub fn unpause_vault(ctx: Context<ManageVault>) -> Result<()> {
        instructions::unpause_vault_handler(ctx)
    }

    pub fn rotate_agent(ctx: Context<RotateAgent>) -> Result<()> {
        instructions::rotate_agent_handler(ctx)
    }

    pub fn create_mandate(
        ctx: Context<CreateMandate>,
        task_id: [u8; 32],
        total_budget: u64,
        max_payment_amount: u64,
        max_purchases: u32,
        approval_threshold: u64,
        expires_at: i64,
        merchant_allowlist: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::create_mandate_handler(
            ctx,
            task_id,
            total_budget,
            max_payment_amount,
            max_purchases,
            approval_threshold,
            expires_at,
            merchant_allowlist,
        )
    }

    pub fn pay_exact(ctx: Context<PayExact>, amount: u64) -> Result<()> {
        instructions::pay_exact_handler(ctx, amount)
    }

    pub fn request_payment(
        ctx: Context<RequestPayment>,
        payment_id: [u8; 32],
        amount: u64,
        offer_hash: [u8; 32],
        deadline: i64,
    ) -> Result<()> {
        instructions::request_payment_handler(ctx, payment_id, amount, offer_hash, deadline)
    }

    pub fn request_approval(
        ctx: Context<RequestApproval>,
        payment_id: [u8; 32],
        amount: u64,
        offer_hash: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        instructions::request_approval_handler(ctx, payment_id, amount, offer_hash, expires_at)
    }

    pub fn approve_request(ctx: Context<ApproveRequest>, deadline: i64) -> Result<()> {
        instructions::approve_request_handler(ctx, deadline)
    }

    pub fn reject_request(ctx: Context<RejectRequest>) -> Result<()> {
        instructions::reject_request_handler(ctx)
    }

    pub fn commit_delivery(ctx: Context<CommitDelivery>, delivery_hash: [u8; 32]) -> Result<()> {
        instructions::commit_delivery_handler(ctx, delivery_hash)
    }

    pub fn release_payment(ctx: Context<ReleasePayment>, delivered_hash: [u8; 32]) -> Result<()> {
        instructions::release_payment_handler(ctx, delivered_hash)
    }

    pub fn refund_payment(ctx: Context<RefundPayment>) -> Result<()> {
        instructions::refund_payment_handler(ctx)
    }

    pub fn claim_after_timeout(ctx: Context<RefundPayment>) -> Result<()> {
        instructions::claim_after_timeout_handler(ctx)
    }
}
