import { PublicKey } from "@solana/web3.js";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { PaymentRequirements, PaymentRequired } from "@x402/core/types";
import { SolMandateClient } from "./client";
import { MandateExactSvmScheme } from "./schemes/exact";
import { MandateEscrowSvmScheme } from "./schemes/escrow";
import { hashBytesToHex } from "@solmandate/verifier";

export interface CreateMandateFetchOptions {
  client: SolMandateClient;
  mandatePda: PublicKey;
  tokenMint: PublicKey;
  defaultNetwork?: string;
  fetch?: typeof globalThis.fetch;
  onPaymentRequired?: (
    req: PaymentRequirements
  ) => void | boolean | Promise<void | boolean>;
  onPaymentSettled?: (result: {
    scheme: string;
    signature: string;
    status: string;
  }) => void;
  onDeliveryVerified?: (result: {
    escrowPda: PublicKey;
    status: "released" | "refunded";
    signature: string;
    error?: string;
  }) => void;
}

export function createMandateFetch(options: CreateMandateFetchOptions) {
  const customFetch = options.fetch || globalThis.fetch;
  const exactScheme = new MandateExactSvmScheme({
    client: options.client,
    mandatePda: options.mandatePda,
    tokenMint: options.tokenMint,
  });
  const escrowScheme = new MandateEscrowSvmScheme({
    client: options.client,
    mandatePda: options.mandatePda,
    tokenMint: options.tokenMint,
  });

  return async function mandateFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    // 1. Initial HTTP Request
    const initialResponse = await customFetch(input, init);

    // If not HTTP 402 Payment Required, return directly
    if (initialResponse.status !== 402) {
      return initialResponse;
    }

    // 2. Parse 402 Payment Requirements
    let paymentRequired: PaymentRequired | null = null;
    const paymentRequiredHeader =
      initialResponse.headers.get("payment-required") ||
      initialResponse.headers.get("PAYMENT-REQUIRED");

    if (paymentRequiredHeader) {
      try {
        paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
      } catch {
        // Fallback: try raw JSON in header
        try {
          paymentRequired = JSON.parse(
            Buffer.from(paymentRequiredHeader, "base64").toString("utf-8")
          );
        } catch {
          // ignore
        }
      }
    }

    if (!paymentRequired) {
      try {
        const bodyJson = await initialResponse.clone().json();
        if (bodyJson && bodyJson.accepts) {
          paymentRequired = bodyJson;
        }
      } catch {
        // Not a JSON body
      }
    }

    if (!paymentRequired || !paymentRequired.accepts || paymentRequired.accepts.length === 0) {
      return initialResponse;
    }

    // 3. Select matching requirement
    // Prefer "escrow" if supported, else "exact"
    const escrowReq = paymentRequired.accepts.find((r: PaymentRequirements) => r.scheme === "escrow");
    const exactReq = paymentRequired.accepts.find((r: PaymentRequirements) => r.scheme === "exact");
    const selectedReq = escrowReq || exactReq || paymentRequired.accepts[0];

    if (options.onPaymentRequired) {
      const allowed = await options.onPaymentRequired(selectedReq);
      if (allowed === false) {
        throw new Error("Payment rejected by onPaymentRequired guardrail");
      }
    }

    const headers = new Headers(init?.headers);

    // 4. Handle Execution Based on Scheme
    if (selectedReq.scheme === "escrow") {
      // MODE 2: Escrow Reservation + Pay-on-Success
      const payloadResult = await escrowScheme.createPaymentPayload(
        paymentRequired.x402Version || 2,
        selectedReq
      );

      const paymentSignatureHeader = encodePaymentSignatureHeader({
        x402Version: paymentRequired.x402Version || 2,
        accepted: selectedReq,
        payload: payloadResult.payload,
      });

      headers.set("payment-signature", paymentSignatureHeader);
      headers.set("PAYMENT-SIGNATURE", paymentSignatureHeader);
      headers.set("x-solmandate-escrow", payloadResult.payload.escrowPda as string);

      const retryInit: RequestInit = {
        ...init,
        headers,
      };

      // Re-fetch paid resource
      const paidResponse = await customFetch(input, retryInit);

      if (paidResponse.status >= 200 && paidResponse.status < 300) {
        const bodyText = await paidResponse.text();
        const expectedDeliveryHash =
          paidResponse.headers.get("x-solmandate-delivery-hash") ||
          paidResponse.headers.get("delivery-hash") ||
          (selectedReq.extra?.expectedHash as string) ||
          hashBytesToHex(bodyText);

        const escrowPda = new PublicKey(payloadResult.payload.escrowPda as string);
        const merchant = new PublicKey(selectedReq.payTo);

        // Verify and Settle / Refund
        const settlement = await escrowScheme.settleOrRefund({
          escrowPda,
          merchant,
          tokenMint: options.tokenMint,
          responseBytesOrString: bodyText,
          expectedDeliveryHash,
        });

        if (options.onDeliveryVerified) {
          options.onDeliveryVerified({
            escrowPda,
            status: settlement.status,
            signature: settlement.signature,
            error: settlement.error,
          });
        }

        // Return new Response with the consumed body
        return new Response(bodyText, {
          status: paidResponse.status,
          statusText: paidResponse.statusText,
          headers: paidResponse.headers,
        });
      } else {
        // Service returned error response -> Auto-refund escrow!
        const escrowPda = new PublicKey(payloadResult.payload.escrowPda as string);
        const refundSig = await options.client.refundPayment({
          mandatePda: options.mandatePda,
          escrowPda,
        });

        if (options.onDeliveryVerified) {
          options.onDeliveryVerified({
            escrowPda,
            status: "refunded",
            signature: refundSig,
            error: `Merchant HTTP error: ${paidResponse.status}`,
          });
        }

        return paidResponse;
      }
    } else {
      // MODE 1: Exact Pay CPI
      const payloadResult = await exactScheme.createPaymentPayload(
        paymentRequired.x402Version || 2,
        selectedReq
      );

      const paymentSignatureHeader = encodePaymentSignatureHeader({
        x402Version: paymentRequired.x402Version || 2,
        accepted: selectedReq,
        payload: payloadResult.payload,
      });

      headers.set("payment-signature", paymentSignatureHeader);
      headers.set("PAYMENT-SIGNATURE", paymentSignatureHeader);
      headers.set("x-solmandate-mandate", options.mandatePda.toBase58());

      if (options.onPaymentSettled) {
        options.onPaymentSettled({
          scheme: "exact",
          signature: payloadResult.payload.signature as string,
          status: "settled",
        });
      }

      const retryInit: RequestInit = {
        ...init,
        headers,
      };

      return await customFetch(input, retryInit);
    }
  };
}
