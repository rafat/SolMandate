import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import { hashBytesToHex } from "@solmandate/verifier";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export interface EscrowAccountParsed {
  paymentId: Uint8Array;
  mandate: PublicKey;
  merchant: PublicKey;
  amount: bigint;
  offerHash: Uint8Array;
  deliveryHash: Uint8Array;
  deadline: bigint;
  state: "Held" | "Delivered" | "Released" | "Refunded" | "Unknown";
  bump: number;
}

export function parseEscrowAccountData(data: Buffer | Uint8Array): EscrowAccountParsed {
  if (data.length < 186) {
    throw new Error("Invalid escrow account data length: expected at least 186 bytes");
  }
  const buf = Buffer.from(data);
  const paymentId = new Uint8Array(buf.subarray(8, 40));
  const mandate = new PublicKey(buf.subarray(40, 72));
  const merchant = new PublicKey(buf.subarray(72, 104));
  const amount = buf.readBigUInt64LE(104);
  const offerHash = new Uint8Array(buf.subarray(112, 144));
  const deliveryHash = new Uint8Array(buf.subarray(144, 176));
  const deadline = buf.readBigInt64LE(176);
  const stateEnum = buf.readUInt8(184);
  const stateNames: ("Held" | "Delivered" | "Released" | "Refunded")[] = [
    "Held",
    "Delivered",
    "Released",
    "Refunded",
  ];
  const state = stateNames[stateEnum] || "Unknown";
  const bump = buf.readUInt8(185);

  return {
    paymentId,
    mandate,
    merchant,
    amount,
    offerHash,
    deliveryHash,
    deadline,
    state,
    bump,
  };
}

export async function verifySolanaExactPayment(
  connection: Connection,
  signature: string,
  expectedAmount: bigint,
  expectedMint: PublicKey,
  merchantPubkey: PublicKey
): Promise<{ valid: boolean; error?: string }> {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      return { valid: false, error: "Transaction not found on-chain or unconfirmed" };
    }
    if (tx.meta?.err) {
      return { valid: false, error: `Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}` };
    }

    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    let receivedAmount = 0n;
    for (const post of postBalances) {
      if (post.owner === merchantPubkey.toBase58() && post.mint === expectedMint.toBase58()) {
        const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
        const preAmount = BigInt(pre?.uiTokenAmount.amount || "0");
        const postAmount = BigInt(post.uiTokenAmount.amount || "0");
        if (postAmount > preAmount) {
          receivedAmount += postAmount - preAmount;
        }
      }
    }

    if (receivedAmount === 0n && tx.transaction.message.instructions) {
      const merchantAta = getAssociatedTokenAddressSync(expectedMint, merchantPubkey, true).toBase58();
      for (const ix of tx.transaction.message.instructions) {
        if ("parsed" in ix && ix.program === "spl-token") {
          const info = ix.parsed.info;
          if (info && (ix.parsed.type === "transfer" || ix.parsed.type === "transferChecked")) {
            if (info.mint && info.mint !== expectedMint.toBase58()) {
              continue;
            }
            if (info.destination === merchantAta) {
              const amt = BigInt(info.amount || "0");
              if (amt >= expectedAmount) {
                receivedAmount = amt;
              }
            }
          }
        }
      }
    }

    if (receivedAmount < expectedAmount) {
      return {
        valid: false,
        error: `Insufficient payment: received ${receivedAmount}, expected >= ${expectedAmount}`,
      };
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: `Verification exception: ${err.message}` };
  }
}

export async function verifySolanaEscrowAccount(
  connection: Connection,
  escrowPda: PublicKey,
  expectedAmount: bigint,
  expectedOfferHashHex: string,
  merchantPubkey: PublicKey
): Promise<{ valid: boolean; error?: string; escrow?: EscrowAccountParsed }> {
  try {
    const accountInfo = await connection.getAccountInfo(escrowPda, "confirmed");
    if (!accountInfo) {
      return { valid: false, error: `Escrow account ${escrowPda.toBase58()} does not exist on-chain` };
    }

    const escrow = parseEscrowAccountData(accountInfo.data);

    if (escrow.merchant.toBase58() !== merchantPubkey.toBase58()) {
      return {
        valid: false,
        error: `Escrow merchant mismatch: on-chain ${escrow.merchant.toBase58()} != expected ${merchantPubkey.toBase58()}`,
      };
    }

    if (escrow.amount < expectedAmount) {
      return {
        valid: false,
        error: `Escrow amount insufficient: on-chain ${escrow.amount} < expected ${expectedAmount}`,
      };
    }

    const onChainOfferHex = Buffer.from(escrow.offerHash).toString("hex");
    if (onChainOfferHex !== expectedOfferHashHex) {
      return {
        valid: false,
        error: `Escrow offer hash mismatch: on-chain ${onChainOfferHex} != expected ${expectedOfferHashHex}`,
      };
    }

    if (escrow.state !== "Held") {
      return {
        valid: false,
        error: `Escrow not in Held state: current state is '${escrow.state}'`,
      };
    }

    const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));
    if (escrow.deadline <= currentTimestamp) {
      return {
        valid: false,
        error: `Escrow deadline passed: deadline ${escrow.deadline} <= current ${currentTimestamp}`,
      };
    }

    return { valid: true, escrow };
  } catch (err: any) {
    return { valid: false, error: `Escrow verification exception: ${err.message}` };
  }
}

export interface MerchantConfig {
  merchantPubkey?: string;
  tokenMint?: string;
  network?: string;
  connection?: Connection;
  facilitatorUrl?: string;
  verifyPayment?: (params: {
    signature: string;
    expectedAmount: string;
    expectedAsset: string;
    expectedRecipient: string;
  }) => Promise<{ valid: boolean; error?: string }>;
  verifyEscrow?: (params: {
    escrowPda: string;
    expectedAmount: string;
    expectedOfferHash: string;
    expectedMerchant: string;
  }) => Promise<{ valid: boolean; error?: string }>;
  onCommitDelivery?: (escrowPda: string, deliveryHash: string) => Promise<string | void>;
  onRefundPayment?: (escrowPda: string) => Promise<string | void>;
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
  app.get("/api/data/exact", async (c) => {
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

    // Payment provided - decode strictly
    let paymentPayload: any;
    try {
      paymentPayload = decodePaymentSignatureHeader(paymentSigHeader);
    } catch {
      try {
        paymentPayload = JSON.parse(
          Buffer.from(paymentSigHeader, "base64").toString("utf-8")
        );
      } catch {
        return c.json({ error: "Invalid or malformed payment-signature header" }, 400);
      }
    }

    if (!paymentPayload || !paymentPayload.accepted || !paymentPayload.payload) {
      return c.json({ error: "Malformed payment payload structure" }, 400);
    }

    // Verify requirement matching
    if (paymentPayload.accepted.scheme !== "exact") {
      return c.json({ error: "Unsupported payment scheme for this endpoint, expected 'exact'" }, 400);
    }
    if (paymentPayload.accepted.asset !== tokenMint) {
      return c.json({ error: "Asset mismatch in payment payload" }, 400);
    }
    if (paymentPayload.accepted.payTo !== merchantPubkey) {
      return c.json({ error: "Recipient mismatch in payment payload" }, 400);
    }
    if (!paymentPayload.payload.signature) {
      return c.json({ error: "Missing transaction signature proof in payment payload" }, 400);
    }

    // Verify payment on-chain
    if (config.verifyPayment) {
      const result = await config.verifyPayment({
        signature: paymentPayload.payload.signature,
        expectedAmount: "1000000",
        expectedAsset: tokenMint,
        expectedRecipient: merchantPubkey,
      });
      if (!result.valid) {
        return c.json({ error: result.error || "Payment verification failed" }, 402);
      }
    } else if (config.facilitatorUrl) {
      try {
        const verifyRes = await fetch(`${config.facilitatorUrl}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scheme: "exact",
            payment: { signature: paymentPayload.payload.signature },
            requirements: {
              amount: "1000000",
              asset: tokenMint,
              payTo: merchantPubkey,
            },
          }),
        });
        const verifyData: any = await verifyRes.json();
        if (!verifyData.valid) {
          return c.json({ error: verifyData.error || "Facilitator rejected payment" }, 402);
        }
      } catch (err: any) {
        return c.json({ error: `Facilitator connection failed: ${err.message}` }, 402);
      }
    } else if (config.connection) {
      const result = await verifySolanaExactPayment(
        config.connection,
        paymentPayload.payload.signature,
        1000000n,
        new PublicKey(tokenMint),
        new PublicKey(merchantPubkey)
      );
      if (!result.valid) {
        return c.json({ error: result.error || "On-chain payment verification failed" }, 402);
      }
    }

    return c.json({
      success: true,
      service: "Solana Validator Telemetry",
      records: [
        { validator: "Vote111...", slot: 294819001, tps: 2854, healthy: true },
        { validator: "Vote222...", slot: 294819002, tps: 2860, healthy: true },
      ],
      paymentProof: paymentPayload.payload.signature,
      mandate: c.req.header("x-solmandate-mandate") || "verified",
      agentTrace: c.req.header("x-agent-trace") || null,
    });
  });

  // POST endpoint with request preservation testing
  app.post("/api/data/post-echo", async (c) => {
    const paymentSigHeader =
      c.req.header("payment-signature") || c.req.header("PAYMENT-SIGNATURE");

    if (!paymentSigHeader) {
      const paymentRequired = {
        x402Version: 2,
        error: "Payment required for POST echo service",
        resource: {
          url: c.req.url,
          description: "SolMandate POST Echo Service",
          mimeType: "application/json",
        },
        accepts: [
          {
            scheme: "exact",
            network,
            asset: tokenMint,
            amount: "1000000",
            payTo: merchantPubkey,
            maxTimeoutSeconds: 300,
          },
        ],
      };

      const encodedHeader = encodePaymentRequiredHeader(paymentRequired as any);
      c.header("PAYMENT-REQUIRED", encodedHeader);
      c.header("payment-required", encodedHeader);
      return c.json(paymentRequired, 402);
    }

    let paymentPayload: any;
    try {
      paymentPayload = decodePaymentSignatureHeader(paymentSigHeader);
    } catch {
      try {
        paymentPayload = JSON.parse(
          Buffer.from(paymentSigHeader, "base64").toString("utf-8")
        );
      } catch {
        return c.json({ error: "Invalid payment-signature header" }, 400);
      }
    }

    if (!paymentPayload?.payload?.signature) {
      return c.json({ error: "Missing signature" }, 400);
    }

    if (config.verifyPayment) {
      const result = await config.verifyPayment({
        signature: paymentPayload.payload.signature,
        expectedAmount: "1000000",
        expectedAsset: tokenMint,
        expectedRecipient: merchantPubkey,
      });
      if (!result.valid) {
        return c.json({ error: result.error || "Payment verification failed" }, 402);
      }
    } else if (config.facilitatorUrl) {
      try {
        const verifyRes = await fetch(`${config.facilitatorUrl}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scheme: "exact",
            payment: { signature: paymentPayload.payload.signature },
            requirements: {
              amount: "1000000",
              asset: tokenMint,
              payTo: merchantPubkey,
            },
          }),
        });
        const verifyData: any = await verifyRes.json();
        if (!verifyData.valid) {
          return c.json({ error: verifyData.error || "Facilitator rejected payment" }, 402);
        }
      } catch (err: any) {
        return c.json({ error: `Facilitator connection failed: ${err.message}` }, 402);
      }
    } else if (config.connection) {
      const result = await verifySolanaExactPayment(
        config.connection,
        paymentPayload.payload.signature,
        1000000n,
        new PublicKey(tokenMint),
        new PublicKey(merchantPubkey)
      );
      if (!result.valid) {
        return c.json({ error: result.error || "Payment verification failed" }, 402);
      }
    }

    let bodyText = "";
    try {
      bodyText = await c.req.text();
    } catch {
      // ignore
    }

    return c.json({
      success: true,
      echoedBody: bodyText,
      echoedHeader: c.req.header("x-custom-post-header") || null,
    });
  });

  // Mode 1/2: Unsupported scheme endpoint for testing fail-closed behavior
  app.get("/api/data/unsupported", (c) => {
    const paymentRequired = {
      x402Version: 2,
      error: "Payment required via unsupported streaming scheme",
      resource: {
        url: c.req.url,
        description: "Unsupported Scheme Feed",
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "streaming",
          network,
          asset: tokenMint,
          amount: "1000000",
          payTo: merchantPubkey,
          maxTimeoutSeconds: 300,
        },
      ],
    };

    const encodedHeader = encodePaymentRequiredHeader(paymentRequired as any);
    c.header("PAYMENT-REQUIRED", encodedHeader);
    c.header("payment-required", encodedHeader);
    return c.json(paymentRequired, 402);
  });

  // Mode 2: Escrow / Pay-on-success endpoint
  app.get("/api/data/escrow", async (c) => {
    const canonicalOfferHash = hashBytesToHex("job:audit_verification:/api/data/escrow:2000000");

    const paymentSigHeader =
      c.req.header("payment-signature") || c.req.header("PAYMENT-SIGNATURE");

    const simulateFail =
      c.req.query("simulate") === "failure" ||
      c.req.header("x-simulate-failure") === "true";

    const simulateCorrupt =
      c.req.query("simulate") === "corrupt_data";

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
              offerHash: canonicalOfferHash,
            },
          },
        ],
      };

      const encodedHeader = encodePaymentRequiredHeader(paymentRequired as any);
      c.header("PAYMENT-REQUIRED", encodedHeader);
      c.header("payment-required", encodedHeader);
      return c.json(paymentRequired, 402);
    }

    // Payment provided - decode strictly
    let paymentPayload: any;
    try {
      paymentPayload = decodePaymentSignatureHeader(paymentSigHeader);
    } catch {
      try {
        paymentPayload = JSON.parse(
          Buffer.from(paymentSigHeader, "base64").toString("utf-8")
        );
      } catch {
        return c.json({ error: "Invalid or malformed payment-signature header" }, 400);
      }
    }

    if (!paymentPayload || !paymentPayload.accepted || !paymentPayload.payload) {
      return c.json({ error: "Malformed payment payload structure" }, 400);
    }

    if (paymentPayload.accepted.scheme !== "escrow") {
      return c.json({ error: "Unsupported payment scheme for this endpoint, expected 'escrow'" }, 400);
    }
    if (paymentPayload.accepted.asset !== tokenMint) {
      return c.json({ error: "Asset mismatch in payment payload" }, 400);
    }
    if (paymentPayload.accepted.payTo !== merchantPubkey) {
      return c.json({ error: "Recipient mismatch in payment payload" }, 400);
    }

    // Extract escrowPda
    const escrowPda =
      c.req.header("x-solmandate-escrow") ||
      c.req.header("X-SOLMANDATE-ESCROW") ||
      paymentPayload.payload.escrowPda;

    if (!escrowPda) {
      return c.json({ error: "Missing escrow account in payment signature" }, 400);
    }

    // Independently verify on-chain escrow account before processing
    if (config.verifyEscrow) {
      const result = await config.verifyEscrow({
        escrowPda,
        expectedAmount: "2000000",
        expectedOfferHash: canonicalOfferHash,
        expectedMerchant: merchantPubkey,
      });
      if (!result.valid) {
        return c.json({ error: result.error || "Escrow verification failed" }, 400);
      }
    } else if (config.facilitatorUrl) {
      try {
        const verifyRes = await fetch(`${config.facilitatorUrl}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scheme: "escrow",
            payment: { escrowPda },
            requirements: {
              amount: "2000000",
              asset: tokenMint,
              payTo: merchantPubkey,
              extra: { offerHash: canonicalOfferHash },
            },
          }),
        });
        const verifyData: any = await verifyRes.json();
        if (!verifyData.valid) {
          return c.json({ error: verifyData.error || "Facilitator rejected escrow" }, 400);
        }
      } catch (err: any) {
        return c.json({ error: `Facilitator connection failed: ${err.message}` }, 400);
      }
    } else if (config.connection) {
      const result = await verifySolanaEscrowAccount(
        config.connection,
        new PublicKey(escrowPda),
        2000000n,
        canonicalOfferHash,
        new PublicKey(merchantPubkey)
      );
      if (!result.valid) {
        return c.json({ error: result.error || "On-chain escrow verification failed" }, 400);
      }
    }

    // If simulating merchant delivery failure (triggers merchant voluntary refund)
    if (simulateFail) {
      if (config.onRefundPayment) {
        try {
          await config.onRefundPayment(escrowPda);
        } catch (err) {
          console.error("Merchant voluntary refund error:", err);
          return c.json(
            {
              error: "Simulated worker fault and refund execution failed",
              code: "REFUND_FAILED",
            },
            500
          );
        }
      }
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

    // Commit delivery on-chain before returning payload
    if (config.onCommitDelivery) {
      try {
        await config.onCommitDelivery(escrowPda, deliveryHash);
      } catch (err) {
        console.error("Merchant failed to commit delivery on-chain:", err);
        return c.json(
          {
            error: "Failed to commit delivery on-chain",
            code: "COMMITMENT_FAILED",
          },
          500
        );
      }
    }

    c.header("X-Solmandate-Delivery-Hash", deliveryHash);
    c.header("x-solmandate-delivery-hash", deliveryHash);
    c.header("Content-Type", "application/json");

    if (simulateCorrupt) {
      // Tampered payload returns data that does not match committed on-chain hash
      return c.text(payload + " /* TAMPERED BY CORRUPT WORKER */", 200);
    }

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
