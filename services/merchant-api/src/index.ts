import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import { hashBytesToHex } from "@solmandate/verifier";

export interface MerchantConfig {
  merchantPubkey?: string;
  tokenMint?: string;
  network?: string;
}

export function createMerchantApp(config: MerchantConfig = {}) {
  const app = new Hono();

  const merchantPubkey =
    config.merchantPubkey ||
    process.env.MERCHANT_PUBKEY ||
    "Merch11111111111111111111111111111111111111";
  const tokenMint =
    config.tokenMint ||
    process.env.TOKEN_MINT ||
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
  const network = config.network || "solana:devnet";

  // Health check
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      merchantPubkey,
      network,
      uptime: process.uptime(),
    });
  });

  // Mode 1: Exact scheme endpoint
  app.get("/api/data/exact", (c) => {
    const paymentSigHeader =
      c.req.header("payment-signature") || c.req.header("PAYMENT-SIGNATURE");

    if (!paymentSigHeader) {
      const paymentRequired = {
        x402Version: 2,
        error: "Payment required to access high-frequency validator telemetry",
        resource: {
          url: c.req.url,
          description: "Solana Validator High-Frequency Telemetry Feed",
          mimeType: "application/json",
        },
        accepts: [
          {
            scheme: "exact",
            network,
            asset: tokenMint,
            amount: "1000000", // 1 USDC (6 decimals)
            payTo: merchantPubkey,
            maxTimeoutSeconds: 300,
            extra: {
              feed: "telemetry",
            },
          },
        ],
      };

      const encodedHeader = encodePaymentRequiredHeader(paymentRequired as any);
      c.header("PAYMENT-REQUIRED", encodedHeader);
      c.header("payment-required", encodedHeader);
      return c.json(paymentRequired, 402);
    }

    // Payment provided
    let paymentPayload: any;
    try {
      paymentPayload = decodePaymentSignatureHeader(paymentSigHeader);
    } catch {
      try {
        paymentPayload = JSON.parse(
          Buffer.from(paymentSigHeader, "base64").toString("utf-8")
        );
      } catch {
        paymentPayload = { raw: paymentSigHeader };
      }
    }

    return c.json({
      success: true,
      service: "Solana Validator Telemetry",
      records: [
        { validator: "Vote111...", slot: 294819001, tps: 2854, healthy: true },
        { validator: "Vote222...", slot: 294819002, tps: 2860, healthy: true },
      ],
      paymentProof: paymentPayload?.payload?.signature || "verified",
      mandate: c.req.header("x-solmandate-mandate") || "verified",
    });
  });

  // Mode 2: Escrow / Pay-on-success endpoint
  app.get("/api/data/escrow", (c) => {
    const paymentSigHeader =
      c.req.header("payment-signature") || c.req.header("PAYMENT-SIGNATURE");

    const simulateFail =
      c.req.query("simulate") === "failure" ||
      c.req.header("x-simulate-failure") === "true";

    if (!paymentSigHeader) {
      const paymentRequired = {
        x402Version: 2,
        error: "Escrow reservation required for AI code verification analysis",
        resource: {
          url: c.req.url,
          description: "AI Smart Contract Audit & Sanitization Report",
          mimeType: "application/json",
        },
        accepts: [
          {
            scheme: "escrow",
            network,
            asset: tokenMint,
            amount: "2000000", // 2 USDC
            payTo: merchantPubkey,
            maxTimeoutSeconds: 3600,
            extra: {
              jobType: "audit_verification",
              offerHash: "0000000000000000000000000000000000000000000000000000000000000000",
            },
          },
        ],
      };

      const encodedHeader = encodePaymentRequiredHeader(paymentRequired as any);
      c.header("PAYMENT-REQUIRED", encodedHeader);
      c.header("payment-required", encodedHeader);
      return c.json(paymentRequired, 402);
    }

    // If simulating merchant delivery failure (triggers agent auto-refund)
    if (simulateFail) {
      c.header("x-solmandate-status", "simulated_failure");
      return c.json(
        {
          error: "Simulated worker fault: data generation corrupted",
          code: "MERCHANT_SERVICE_DEGRADED",
        },
        500
      );
    }

    const payload = JSON.stringify({
      success: true,
      service: "AI Smart Contract Audit & Sanitization Report",
      findings: [
        { severity: "High", title: "Missing CPI signer check", resolved: true },
        { severity: "Low", title: "Unindexed account search", resolved: true },
      ],
      score: 98,
      timestamp: Date.now(),
    });

    const deliveryHash = hashBytesToHex(payload);
    c.header("X-Solmandate-Delivery-Hash", deliveryHash);
    c.header("x-solmandate-delivery-hash", deliveryHash);
    c.header("Content-Type", "application/json");

    return c.text(payload, 200);
  });

  return app;
}

// Start standalone server if executed directly
if (typeof require !== "undefined" && require.main === module) {
  const port = Number(process.env.PORT) || 4020;
  const app = createMerchantApp();
  console.log(`🚀 SolMandate Merchant API listening on http://localhost:${port}`);
  serve({
    fetch: app.fetch,
    port,
  });
}
