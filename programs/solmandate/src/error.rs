use anchor_lang::prelude::*;

#[error_code]
pub enum SolMandateError {
    #[msg("Vault is paused by owner")]
    VaultPaused,
    #[msg("Mandate has expired")]
    MandateExpired,
    #[msg("Payment amount exceeds maximum payment cap")]
    PaymentCapExceeded,
    #[msg("Payment amount exceeds available budget")]
    BudgetExceeded,
    #[msg("Maximum purchase limit reached for this mandate")]
    MaxPurchasesExceeded,
    #[msg("Merchant is not on the mandate allowlist")]
    MerchantNotAllowed,
    #[msg("Payment exceeds approval threshold and requires human authorization")]
    RequiresApproval,
    #[msg("Escrow is in an invalid state for this operation")]
    InvalidEscrowState,
    #[msg("Delivered hash does not match committed hash")]
    DeliveryHashMismatch,
    #[msg("Timeout has not yet been reached")]
    TimeoutNotReached,
    #[msg("Escrow deadline has passed")]
    DeadlinePassed,
    #[msg("Signer is not authorized for this operation")]
    Unauthorized,
    #[msg("Arithmetic overflow in budget calculation")]
    ArithmeticOverflow,
}
