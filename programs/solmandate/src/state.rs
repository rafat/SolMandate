use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub token_mint: Pubkey,
    pub token_vault: Pubkey,
    pub is_paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub vault: Pubkey,
    pub task_id: [u8; 32],
    pub total_budget: u64,
    pub reserved_amount: u64,
    pub settled_amount: u64,
    pub max_payment_amount: u64,
    pub max_purchases: u32,
    pub purchase_count: u32,
    pub approval_threshold: u64,
    pub expires_at: i64,
    #[max_len(16)]
    pub merchant_allowlist: Vec<Pubkey>,
    pub bump: u8,
}

impl Mandate {
    pub fn available_budget(&self) -> Option<u64> {
        self.total_budget
            .checked_sub(self.settled_amount)?
            .checked_sub(self.reserved_amount)
    }

    pub fn is_merchant_allowed(&self, merchant: &Pubkey) -> bool {
        if self.merchant_allowlist.is_empty() {
            true
        } else {
            self.merchant_allowlist.contains(merchant)
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowState {
    Held,
    Delivered,
    Released,
    Refunded,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub payment_id: [u8; 32],
    pub mandate: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub offer_hash: [u8; 32],
    pub delivery_hash: [u8; 32],
    pub deadline: i64,
    pub state: EscrowState,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PendingApproval {
    pub payment_id: [u8; 32],
    pub mandate: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub offer_hash: [u8; 32],
    pub requested_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Merchant {
    pub payout_address: Pubkey,
    pub total_completed: u64,
    pub total_refunded: u64,
    pub total_volume: u64,
    pub bump: u8,
}
