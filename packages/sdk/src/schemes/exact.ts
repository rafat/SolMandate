import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import { SolMandateClient } from "../client";

export interface MandateExactSchemeOptions {
  client: SolMandateClient;
  mandatePda: PublicKey;
  tokenMint?: PublicKey;
}

export class MandateExactSvmScheme implements SchemeNetworkClient {
  public readonly scheme = "exact";
  public readonly client: SolMandateClient;
  public readonly mandatePda: PublicKey;
  public readonly tokenMint?: PublicKey;

  constructor(options: MandateExactSchemeOptions) {
    this.client = options.client;
    this.mandatePda = options.mandatePda;
    this.tokenMint = options.tokenMint;
  }

  /**
   * Official x402 v2 payload generator
   */
  public async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext
  ): Promise<PaymentPayloadResult> {
    const merchant = new PublicKey(paymentRequirements.payTo);
    const amount = new BN(paymentRequirements.amount);
    const mint =
      this.tokenMint ||
      (paymentRequirements.asset ? new PublicKey(paymentRequirements.asset) : undefined);

    if (!mint) {
      throw new Error(
        "Token mint must be provided in MandateExactSchemeOptions or paymentRequirements.asset"
      );
    }

    const res = await this.pay({
      merchant,
      amount,
      tokenMint: mint,
    });

    return {
      x402Version,
      payload: {
        signature: res.signature,
        mandatePda: this.mandatePda.toBase58(),
        merchant: merchant.toBase58(),
        amount: amount.toString(),
      },
    };
  }

  /**
   * Executes the on-chain pay_exact instruction and returns the signature payload
   */
  public async pay(params: {
    merchant: PublicKey;
    amount: string | number | BN;
    tokenMint: PublicKey;
  }): Promise<{ signature: string; mandatePda: string }> {
    const merchantTokenAccount = getAssociatedTokenAddressSync(
      params.tokenMint,
      params.merchant,
      true
    );

    const amountBn = new BN(params.amount.toString());

    const signature = await this.client.payExact({
      mandatePda: this.mandatePda,
      merchant: params.merchant,
      merchantTokenAccount,
      amount: amountBn,
    });

    return {
      signature,
      mandatePda: this.mandatePda.toBase58(),
    };
  }
}
