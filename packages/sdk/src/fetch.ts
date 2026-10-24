import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { PaymentRequirements, PaymentRequired } from "@x402/core/types";
import { SolMandateClient } from "./client";
import { MandateExactSvmScheme } from "./schemes/exact";
import { MandateEscrowSvmScheme } from "./schemes/escrow";
import { hashBytesToHex } from "@solmandate/verifier";

export class DeliveryVerificationError extends Error {
  public readonly escrowPda: PublicKey;
  public readonly actualHash: string;
  public readonly committedHash?: string;
  public readonly response: Response;

  constructor(
    message: string,
    escrowPda: PublicKey,
    actualHash: string,
    response: Response,
    committedHash?: string
  ) {
    super(message);
    this.name = "DeliveryVerificationError";
    this.escrowPda = escrowPda;
    this.actualHash = actualHash;
    this.committedHash = committedHash;
    this.response = response;
  }
}

export interface CreateMandateFetchOptions {
  client: SolMandateClient;
  mandatePda: PublicKey;
  tokenMint: PublicKey;
  defaultNetwork?: string;
  allowedNetworks?: string[];
  maxPaymentAmount?: bigint | number;
  allowUnverifiedContent?: boolean;
  fetch?: typeof globalThis.fetch;
  onPaymentRequired?: (
    req: PaymentRequirements
  ) => void | boolean | Promise<void | boolean>;
  onPaymentSettled?: (result: {
    scheme: string;
    signature: string;
    status: "payment_submitted" | "payment_confirmed" | "resource_delivered" | "payment_failed";
    error?: string;
  }) => void;
  onDeliveryVerified?: (result: {
    escrowPda: PublicKey;
    status: "released" | "refunded" | "refund_pending" | "verification_failed" | "release_failed";
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

    // 3. Select matching requirement - fail closed if neither escrow nor exact is supported
    const escrowReq = paymentRequired.accepts.find((r: PaymentRequirements) => r.scheme === "escrow");
    const exactReq = paymentRequired.accepts.find((r: PaymentRequirements) => r.scheme === "exact");
    const selectedReq = escrowReq || exactReq;

    if (!selectedReq) {
      // Fail closed on unsupported scheme
      return initialResponse;
    }

    // Strict validation of payment requirements before committing funds
    if (!selectedReq.network) {
      throw new Error("Invalid payment requirements: missing 'network'");
    }
    const allowedNetworks = options.allowedNetworks || (options.defaultNetwork ? [options.defaultNetwork] : ["solana:localnet", "solana:devnet", "solana:mainnet"]);
    if (!allowedNetworks.includes(selectedReq.network)) {
      throw new Error(
        `Network '${selectedReq.network}' is not permitted by client policy (allowed: ${allowedNetworks.join(", ")})`
      );
    }

    if (!selectedReq.asset) {
      throw new Error("Invalid payment requirements: missing 'asset'");
    }
    if (selectedReq.asset !== options.tokenMint.toBase58()) {
      throw new Error(
        `Asset mismatch: resource requires ${selectedReq.asset}, but client configured for ${options.tokenMint.toBase58()}`
      );
    }

    if (!selectedReq.payTo) {
      throw new Error("Invalid payment requirements: missing 'payTo'");
    }

    if (!selectedReq.amount) {
      throw new Error("Invalid payment requirements: missing 'amount'");
    }
    const reqAmount = BigInt(selectedReq.amount);
    if (reqAmount <= 0n) {
      throw new Error(`Invalid payment amount: ${selectedReq.amount}`);
    }
    if (options.maxPaymentAmount && reqAmount > BigInt(options.maxPaymentAmount)) {
      throw new Error(
        `Requested amount ${reqAmount} exceeds client configured max payment amount ${options.maxPaymentAmount}`
      );
    }

    if (options.onPaymentRequired) {
      const allowed = await options.onPaymentRequired(selectedReq);
      if (allowed === false) {
        throw new Error("Payment rejected by onPaymentRequired guardrail");
      }
    }

    // Preserve original request headers and body on retry
    let requestUrl: string | URL;
    const requestHeaders = new Headers();
    let requestMethod = init?.method;
    let requestBody = init?.body;

    if (input instanceof Request) {
      requestUrl = input.url;
      requestMethod = requestMethod || input.method;
      input.headers.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
      if (requestBody === undefined && input.body) {
        requestBody = await input.clone().arrayBuffer();
      }
    } else {
      requestUrl = input;
      requestMethod = requestMethod || "GET";
    }

    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    }

    if (requestMethod === "GET" || requestMethod === "HEAD") {
      requestBody = undefined;
    }

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

      requestHeaders.set("payment-signature", paymentSignatureHeader);
      requestHeaders.set("PAYMENT-SIGNATURE", paymentSignatureHeader);
      requestHeaders.set("x-solmandate-escrow", payloadResult.payload.escrowPda as string);

      const retryInit: RequestInit = {
        ...init,
        method: requestMethod,
        headers: requestHeaders,
        body: requestBody,
      };

      // Re-fetch paid resource
      const paidResponse = await customFetch(requestUrl, retryInit);
      const escrowPda = new PublicKey(payloadResult.payload.escrowPda as string);
      const merchant = new PublicKey(selectedReq.payTo);

      if (paidResponse.status >= 200 && paidResponse.status < 300) {
        // Compute actual SHA-256 hash of response bytes
        const responseBytes = new Uint8Array(await paidResponse.clone().arrayBuffer());
        const actualHashHex = hashBytesToHex(responseBytes);

        // Fetch on-chain escrow to independently verify merchant delivery commitment
        const escrow = await options.client.fetchEscrow(escrowPda);
        const isDelivered =
          escrow.state && typeof escrow.state === "object" && "delivered" in escrow.state;

        if (!isDelivered) {
          options.onDeliveryVerified?.({
            escrowPda,
            status: "verification_failed",
            signature: "",
            error: "Escrow is not in Delivered state on-chain",
          });
          if (!options.allowUnverifiedContent) {
            throw new DeliveryVerificationError(
              "Escrow is not in Delivered state on-chain",
              escrowPda,
              actualHashHex,
              paidResponse
            );
          }
          return paidResponse;
        }

        const committedHashHex = Buffer.from(escrow.deliveryHash).toString("hex");
        const isZeroHash = escrow.deliveryHash.every((b: number) => b === 0);

        if (isZeroHash) {
          options.onDeliveryVerified?.({
            escrowPda,
            status: "verification_failed",
            signature: "",
            error: "Merchant delivery commitment on-chain is all zeroes",
          });
          if (!options.allowUnverifiedContent) {
            throw new DeliveryVerificationError(
              "Merchant delivery commitment on-chain is all zeroes",
              escrowPda,
              actualHashHex,
              paidResponse,
              committedHashHex
            );
          }
          return paidResponse;
        }

        if (actualHashHex !== committedHashHex) {
          options.onDeliveryVerified?.({
            escrowPda,
            status: "verification_failed",
            signature: "",
            error: `Hash mismatch: response hash ${actualHashHex} does not match on-chain commitment ${committedHashHex}`,
          });
          if (!options.allowUnverifiedContent) {
            throw new DeliveryVerificationError(
              `Hash mismatch: response hash ${actualHashHex} does not match on-chain commitment ${committedHashHex}`,
              escrowPda,
              actualHashHex,
              paidResponse,
              committedHashHex
            );
          }
          return paidResponse;
        }

        // On-chain delivery verified! Release payment
        const merchantTokenAccount = getAssociatedTokenAddressSync(
          options.tokenMint,
          merchant,
          true
        );

        try {
          const releaseSig = await options.client.releasePayment({
            mandatePda: options.mandatePda,
            escrowPda,
            merchant,
            merchantTokenAccount,
            deliveredHash: actualHashHex,
          });

          options.onDeliveryVerified?.({
            escrowPda,
            status: "released",
            signature: releaseSig,
          });
        } catch (releaseErr: any) {
          options.onDeliveryVerified?.({
            escrowPda,
            status: "release_failed",
            signature: "",
            error: `Payment release transaction failed: ${releaseErr.message}`,
          });
          throw releaseErr;
        }

        // Return original response without consuming/reconstructing
        return paidResponse;
      } else {
        // Service returned error response (e.g. 500)
        try {
          const escrow = await options.client.fetchEscrow(escrowPda);
          const isRefunded =
            escrow.state && typeof escrow.state === "object" && "refunded" in escrow.state;

          if (isRefunded) {
            options.onDeliveryVerified?.({
              escrowPda,
              status: "refunded",
              signature: "confirmed_on_chain",
              error: `Merchant HTTP error: ${paidResponse.status}`,
            });
          } else {
            options.onDeliveryVerified?.({
              escrowPda,
              status: "refund_pending",
              signature: "",
              error: `Merchant HTTP error: ${paidResponse.status}. Escrow remains unrefunded.`,
            });
          }
        } catch (err: any) {
          options.onDeliveryVerified?.({
            escrowPda,
            status: "refund_pending",
            signature: "",
            error: `Merchant HTTP error: ${paidResponse.status}. Failed to fetch escrow state: ${err.message}`,
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

      requestHeaders.set("payment-signature", paymentSignatureHeader);
      requestHeaders.set("PAYMENT-SIGNATURE", paymentSignatureHeader);
      requestHeaders.set("x-solmandate-mandate", options.mandatePda.toBase58());

      options.onPaymentSettled?.({
        scheme: "exact",
        signature: payloadResult.payload.signature as string,
        status: "payment_submitted",
      });

      // Confirm transaction on-chain before retrying request
      try {
        await options.client.connection.confirmTransaction(
          payloadResult.payload.signature as string,
          "confirmed"
        );
        options.onPaymentSettled?.({
          scheme: "exact",
          signature: payloadResult.payload.signature as string,
          status: "payment_confirmed",
        });
      } catch (confirmErr: any) {
        options.onPaymentSettled?.({
          scheme: "exact",
          signature: payloadResult.payload.signature as string,
          status: "payment_failed",
          error: `Transaction confirmation failed: ${confirmErr.message}`,
        });
        throw confirmErr;
      }

      const retryInit: RequestInit = {
        ...init,
        method: requestMethod,
        headers: requestHeaders,
        body: requestBody,
      };

      const paidResponse = await customFetch(requestUrl, retryInit);

      if (paidResponse.status >= 200 && paidResponse.status < 300) {
        options.onPaymentSettled?.({
          scheme: "exact",
          signature: payloadResult.payload.signature as string,
          status: "resource_delivered",
        });
      } else {
        options.onPaymentSettled?.({
          scheme: "exact",
          signature: payloadResult.payload.signature as string,
          status: "payment_failed",
          error: `HTTP error: ${paidResponse.status}`,
        });
      }

      return paidResponse;
    }
  };
}
