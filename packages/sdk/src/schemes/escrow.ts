import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import crypto from "crypto";
import {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import { SolMandateClient } from "../client";
import { verifyResponseHash } from "@solmandate/verifier";

export interface MandateEscrowSchemeOptions {
  client: SolMandateClient;
  mandatePda: PublicKey;
  tokenMint?: PublicKey;
}

export class MandateEscrowSvmScheme implements SchemeNetworkClient {
  public readonly scheme = "escrow";
  public readonly client: SolMandateClient;
  public readonly mandatePda: PublicKey;
  public readonly tokenMint?: PublicKey;

  constructor(options: MandateEscrowSchemeOptions) {
    this.client = options.client;
    this.mandatePda = options.mandatePda;
    this.tokenMint = options.tokenMint;
  }

  /**
   * Official x402 v2 payload generator: reserves funds in on-chain escrow
   */
  public async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext
  ): Promise<PaymentPayloadResult> {
    const merchant = new PublicKey(paymentRequirements.payTo);
    const amount = new BN(paymentRequirements.amount);
    const paymentId =
      (paymentRequirements.extra?.paymentId as string) ||
      crypto.randomBytes(16).toString("hex");
    const offerHash =
      (paymentRequirements.extra?.offerHash as string) ||
      crypto.createHash("sha256").update(paymentId).digest("hex");
    const deadlineSeconds = paymentRequirements.maxTimeoutSeconds || 3600;

    const res = await this.reserveEscrow({
      merchant,
      amount,
      paymentId,
      offerHash,
      deadlineSeconds,
    });

    return {
      x402Version,
      payload: {
        signature: res.signature,
        mandatePda: this.mandatePda.toBase58(),
        escrowPda: res.escrowPda.toBase58(),
        paymentId: res.paymentId,
        amount: amount.toString(),
      },
    };
  }

  /**
   * Reserves funds into on-chain escrow
   */
  public async reserveEscrow(params: {
    merchant: PublicKey;
    amount: string | number | BN;
    paymentId?: string;
    offerHash?: string;
    deadlineSeconds?: number;
  }): Promise<{
    paymentId: string;
    escrowPda: PublicKey;
    signature: string;
  }> {
    const paymentIdStr = params.paymentId || crypto.randomBytes(16).toString("hex");
    const offerHashStr =
      params.offerHash || crypto.createHash("sha256").update(paymentIdStr).digest("hex");
    const deadline = Math.floor(Date.now() / 1000) + (params.deadlineSeconds || 3600);
    const amountBn = new BN(params.amount.toString());

    const { signature, escrowPda } = await this.client.requestPayment({
      mandatePda: this.mandatePda,
      paymentId: paymentIdStr,
      merchant: params.merchant,
      amount: amountBn,
      offerHash: offerHashStr,
      deadline,
    });

    return {
      paymentId: paymentIdStr,
      escrowPda,
      signature,
    };
  }

  /**
   * Verifies delivery payload and releases funds if matching, or refunds if invalid
   */
  public async settleOrRefund(params: {
    escrowPda: PublicKey;
    merchant: PublicKey;
    tokenMint: PublicKey;
    responseBytesOrString: Uint8Array | string;
    expectedDeliveryHash: Uint8Array | number[] | string;
  }): Promise<{ status: "released" | "refunded"; signature: string; error?: string }> {
    const isValid = verifyResponseHash(
      params.responseBytesOrString,
      params.expectedDeliveryHash
    );

    if (isValid) {
      const merchantTokenAccount = getAssociatedTokenAddressSync(
        params.tokenMint,
        params.merchant,
        true
      );

      const signature = await this.client.releasePayment({
        mandatePda: this.mandatePda,
        escrowPda: params.escrowPda,
        merchant: params.merchant,
        merchantTokenAccount,
        deliveredHash: params.expectedDeliveryHash,
      });

      return { status: "released", signature };
    } else {
      // Verification failed -> auto-refund to vault, restoring budget!
      const signature = await this.client.refundPayment({
        mandatePda: this.mandatePda,
        escrowPda: params.escrowPda,
      });

      return {
        status: "refunded",
        signature,
        error: "Delivery verification failed: response hash does not match committed hash",
      };
    }
  }
}
