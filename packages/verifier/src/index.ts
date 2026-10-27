import crypto from "crypto";
import { ZodTypeAny } from "zod";

export const SOLMANDATE_PROGRAM_ID = "CBuziEesW1tEjs1vbY6pnXVRMzmqwvjuEJty8UQdCyD8";

export const ESCROW_ACCOUNT_DISCRIMINATOR = new Uint8Array([
  0x1f, 0xd5, 0x7b, 0xbb, 0xba, 0x16, 0xda, 0x9b,
]);

export const MANDATE_ACCOUNT_DISCRIMINATOR = new Uint8Array([
  0x71, 0xd8, 0x62, 0x9f, 0xb9, 0x3f, 0x37, 0x12,
]);

export function matchAccountDiscriminator(
  data: Uint8Array | Buffer,
  expectedDiscriminator: Uint8Array
): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (data[i] !== expectedDiscriminator[i]) return false;
  }
  return true;
}

export function hashBytes(data: Uint8Array | string): Uint8Array {
  const hash = crypto.createHash("sha256");
  if (typeof data === "string") {
    hash.update(Buffer.from(data, "utf8"));
  } else {
    hash.update(Buffer.from(data));
  }
  return new Uint8Array(hash.digest());
}

export function hashBytesToHex(data: Uint8Array | string): string {
  return Buffer.from(hashBytes(data)).toString("hex");
}

export function buildCanonicalOfferHash(params: {
  resource: string;
  jobType?: string;
  amount: string | bigint | number;
}): string {
  const prefix = params.jobType ? `job:${params.jobType}:` : "";
  return hashBytesToHex(`${prefix}${params.resource}:${params.amount.toString()}`);
}

export function verifyResponseHash(
  data: Uint8Array | string,
  expectedHash: Uint8Array | number[] | string
): boolean {
  const actual = hashBytes(data);
  let expected: Uint8Array;

  if (typeof expectedHash === "string") {
    expected = new Uint8Array(Buffer.from(expectedHash, "hex"));
  } else if (Array.isArray(expectedHash)) {
    expected = new Uint8Array(expectedHash);
  } else {
    expected = expectedHash;
  }

  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function verifyJsonSchema(
  data: unknown,
  schema: ZodTypeAny
): { valid: boolean; error?: string } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true };
  } else {
    return {
      valid: false,
      error: result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "),
    };
  }
}

export interface PaymentIntent {
  intentId: string;
  scheme: "exact" | "escrow";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  offerHash?: string;
  resource?: string;
  maxTimeoutSeconds?: number;
  createdAt: number;
  expiresAt: number;
}

export interface PaymentRecordResult {
  success: boolean;
  error?: string;
}

export interface IPaymentIntentStore {
  createIntent(intent: PaymentIntent): Promise<void> | void;
  getIntent(intentId: string): Promise<PaymentIntent | undefined> | (PaymentIntent | undefined);
  recordSettlement(proofKey: string, intentId?: string): Promise<PaymentRecordResult> | PaymentRecordResult;
  isSettled(proofKey: string): Promise<boolean> | boolean;
  isIntentFulfilled(intentId: string): Promise<boolean> | boolean;
}

export class MemoryPaymentIntentStore implements IPaymentIntentStore {
  private intents: Map<string, PaymentIntent> = new Map();
  private settledProofs: Map<string, { settledAt: number; intentId?: string }> = new Map();
  private fulfilledIntents: Set<string> = new Set();

  createIntent(intent: PaymentIntent): void {
    this.intents.set(intent.intentId, { ...intent });
  }

  getIntent(intentId: string): PaymentIntent | undefined {
    return this.intents.get(intentId);
  }

  recordSettlement(proofKey: string, intentId?: string): PaymentRecordResult {
    if (this.settledProofs.has(proofKey)) {
      return {
        success: false,
        error: `Payment proof ${proofKey} has already been settled (replay detected)`,
      };
    }
    if (intentId) {
      if (this.fulfilledIntents.has(intentId)) {
        return {
          success: false,
          error: `Payment intent ${intentId} has already been fulfilled`,
        };
      }
      this.fulfilledIntents.add(intentId);
    }
    this.settledProofs.set(proofKey, { settledAt: Date.now(), intentId });
    return { success: true };
  }

  isSettled(proofKey: string): boolean {
    return this.settledProofs.has(proofKey);
  }

  isIntentFulfilled(intentId: string): boolean {
    return this.fulfilledIntents.has(intentId);
  }
}
