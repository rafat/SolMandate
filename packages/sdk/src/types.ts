import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export interface CreateVaultParams {
  agent: PublicKey;
  tokenMint: PublicKey;
}

export interface DepositParams {
  amount: BN | number | bigint;
  funderTokenAccount: PublicKey;
}

export interface CreateMandateParams {
  taskId: Uint8Array | number[] | string;
  totalBudget: BN | number | bigint;
  maxPaymentAmount: BN | number | bigint;
  maxPurchases: number;
  approvalThreshold: BN | number | bigint;
  expiresAt: number | BN;
  merchantAllowlist?: PublicKey[];
}

export interface PayExactParams {
  mandatePda: PublicKey;
  merchant: PublicKey;
  merchantTokenAccount: PublicKey;
  amount: BN | number | bigint;
}

export interface RequestPaymentParams {
  mandatePda: PublicKey;
  paymentId: Uint8Array | number[] | string;
  merchant: PublicKey;
  amount: BN | number | bigint;
  offerHash: Uint8Array | number[] | string;
  deadline: number | BN;
}

export interface RequestApprovalParams {
  mandatePda: PublicKey;
  paymentId: Uint8Array | number[] | string;
  merchant: PublicKey;
  amount: BN | number | bigint;
  offerHash: Uint8Array | number[] | string;
  expiresAt: number | BN;
}

export interface ApproveRequestParams {
  mandatePda: PublicKey;
  paymentId: Uint8Array | number[] | string;
  deadline: number | BN;
}

export interface RejectRequestParams {
  mandatePda: PublicKey;
  paymentId: Uint8Array | number[] | string;
}

export interface CommitDeliveryParams {
  escrowPda: PublicKey;
  deliveryHash: Uint8Array | number[] | string;
}

export interface ReleasePaymentParams {
  mandatePda: PublicKey;
  escrowPda: PublicKey;
  merchant: PublicKey;
  merchantTokenAccount: PublicKey;
  deliveredHash?: Uint8Array | number[] | string;
}

export interface RefundPaymentParams {
  mandatePda: PublicKey;
  escrowPda: PublicKey;
}

export interface ClaimAfterTimeoutParams {
  mandatePda: PublicKey;
  escrowPda: PublicKey;
}

export type EscrowStatus = "Held" | "Delivered" | "Released" | "Refunded";

export interface EscrowAccountData {
  paymentId: number[];
  mandate: PublicKey;
  merchant: PublicKey;
  amount: BN;
  offerHash: number[];
  deliveryHash: number[];
  deadline: BN;
  state: { [key in EscrowStatus]?: Record<string, never> } | EscrowStatus;
  bump: number;
}

export interface MandateAccountData {
  vault: PublicKey;
  taskId: number[];
  totalBudget: BN;
  reservedAmount: BN;
  settledAmount: BN;
  maxPaymentAmount: BN;
  maxPurchases: number;
  purchaseCount: number;
  approvalThreshold: BN;
  expiresAt: BN;
  merchantAllowlist: PublicKey[];
  bump: number;
}

export interface VaultAccountData {
  owner: PublicKey;
  agent: PublicKey;
  tokenMint: PublicKey;
  tokenVault: PublicKey;
  isPaused: boolean;
  bump: number;
  vaultBump: number;
}
