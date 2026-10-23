import { PublicKey } from "@solana/web3.js";
import crypto from "crypto";

export const VAULT_SEED = Buffer.from("vault");
export const TOKEN_VAULT_SEED = Buffer.from("token_vault");
export const MANDATE_SEED = Buffer.from("mandate");
export const ESCROW_SEED = Buffer.from("escrow");
export const PENDING_SEED = Buffer.from("pending");

export function to32ByteArray(input: Uint8Array | number[] | string): Buffer {
  if (typeof input === "string") {
    // If it's a 64-char hex string, decode it; otherwise hash it
    if (/^[0-9a-fA-F]{64}$/.test(input)) {
      return Buffer.from(input, "hex");
    }
    return crypto.createHash("sha256").update(Buffer.from(input, "utf8")).digest();
  }
  const buf = Buffer.from(input);
  if (buf.length === 32) return buf;
  return crypto.createHash("sha256").update(buf).digest();
}

export function findVaultPda(owner: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, owner.toBuffer()], programId);
}

export function findTokenVaultPda(vaultPda: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TOKEN_VAULT_SEED, vaultPda.toBuffer()], programId);
}

export function findMandatePda(
  vaultPda: PublicKey,
  taskId: Uint8Array | number[] | string,
  programId: PublicKey
): [PublicKey, number] {
  const taskIdBuffer = to32ByteArray(taskId);
  return PublicKey.findProgramAddressSync([MANDATE_SEED, vaultPda.toBuffer(), taskIdBuffer], programId);
}

export function findEscrowPda(
  mandatePda: PublicKey,
  paymentId: Uint8Array | number[] | string,
  programId: PublicKey
): [PublicKey, number] {
  const paymentIdBuffer = to32ByteArray(paymentId);
  return PublicKey.findProgramAddressSync([ESCROW_SEED, mandatePda.toBuffer(), paymentIdBuffer], programId);
}

export function findPendingApprovalPda(
  mandatePda: PublicKey,
  paymentId: Uint8Array | number[] | string,
  programId: PublicKey
): [PublicKey, number] {
  const paymentIdBuffer = to32ByteArray(paymentId);
  return PublicKey.findProgramAddressSync([PENDING_SEED, mandatePda.toBuffer(), paymentIdBuffer], programId);
}
