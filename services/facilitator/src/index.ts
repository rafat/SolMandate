import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  hashBytesToHex,
  matchAccountDiscriminator,
  SOLMANDATE_PROGRAM_ID,
  ESCROW_ACCOUNT_DISCRIMINATOR,
  MANDATE_ACCOUNT_DISCRIMINATOR,
  PaymentIntent,
  IPaymentIntentStore,
  MemoryPaymentIntentStore,
} from "@solmandate/verifier";

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

export async function verifyExactPayment(
  connection: Connection,
  signature: string,
  expectedAmount: bigint,
  expectedMint: PublicKey,
  merchantPubkey: PublicKey
): Promise<{ valid: boolean; error?: string; txDetails?: any }> {
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

    // Inspect instruction-level SPL token transfers (top-level and inner CPI)
    const merchantAta = getAssociatedTokenAddressSync(expectedMint, merchantPubkey, true).toBase58();
    const allInstructions: any[] = [...(tx.transaction.message.instructions || [])];
    if (tx.meta?.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        if (inner.instructions) {
          allInstructions.push(...inner.instructions);
        }
      }
    }

    let instructionTransferAmount = 0n;
    for (const ix of allInstructions) {
      if ("parsed" in ix && ix.program === "spl-token") {
        const info = ix.parsed.info;
        if (info && (ix.parsed.type === "transfer" || ix.parsed.type === "transferChecked")) {
          if (info.mint && info.mint !== expectedMint.toBase58()) {
            continue;
          }
          if (info.destination === merchantAta) {
            const amt = BigInt(info.amount || "0");
            instructionTransferAmount += amt;
          }
        }
      }
    }

    const effectiveReceived = receivedAmount > 0n ? receivedAmount : instructionTransferAmount;

    if (effectiveReceived < expectedAmount) {
      return {
        valid: false,
        error: `Insufficient payment: received ${effectiveReceived}, expected >= ${expectedAmount}`,
      };
    }

    return {
      valid: true,
      txDetails: {
        slot: tx.slot,
        blockTime: tx.blockTime,
        receivedAmount: effectiveReceived.toString(),
        merchant: merchantPubkey.toBase58(),
        mint: expectedMint.toBase58(),
      },
    };
  } catch (err: any) {
    return { valid: false, error: `Verification exception: ${err.message}` };
  }
}

export async function verifyEscrowAccount(
  connection: Connection,
  escrowPda: PublicKey,
  expectedAmount: bigint,
  expectedOfferHashHex: string,
  merchantPubkey: PublicKey,
  programId: PublicKey = new PublicKey(SOLMANDATE_PROGRAM_ID)
): Promise<{ valid: boolean; error?: string; escrow?: EscrowAccountParsed }> {
  try {
    const accountInfo = await connection.getAccountInfo(escrowPda, "confirmed");
    if (!accountInfo) {
      return { valid: false, error: `Escrow account ${escrowPda.toBase58()} does not exist on-chain` };
    }

    // Authenticate account owner against canonical SolMandate program ID
    if (!accountInfo.owner.equals(programId)) {
      return {
        valid: false,
        error: `Escrow account owner mismatch: expected program ${programId.toBase58()}, got ${accountInfo.owner.toBase58()}`,
      };
    }

    // Verify 8-byte Anchor account discriminator
    if (!matchAccountDiscriminator(accountInfo.data, ESCROW_ACCOUNT_DISCRIMINATOR)) {
      return {
        valid: false,
        error: "Invalid account discriminator: account is not a genuine SolMandate Escrow",
      };
    }

    const escrow = parseEscrowAccountData(accountInfo.data);

    // Verify PDA equality derived strictly from seeds: [b"escrow", mandate, payment_id]
    const [expectedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), escrow.mandate.toBuffer(), escrow.paymentId],
      programId
    );
    if (!expectedPda.equals(escrowPda)) {
      return {
        valid: false,
        error: `Escrow PDA derivation mismatch: address ${escrowPda.toBase58()} does not match seeds derivation ${expectedPda.toBase58()}`,
      };
    }

    // Verify referenced Mandate account exists and is authentic
    const mandateAccountInfo = await connection.getAccountInfo(escrow.mandate, "confirmed");
    if (!mandateAccountInfo) {
      return {
        valid: false,
        error: `Referenced mandate account ${escrow.mandate.toBase58()} does not exist on-chain`,
      };
    }
    if (!mandateAccountInfo.owner.equals(programId)) {
      return {
        valid: false,
        error: `Referenced mandate owner mismatch: expected ${programId.toBase58()}, got ${mandateAccountInfo.owner.toBase58()}`,
      };
    }
    if (!matchAccountDiscriminator(mandateAccountInfo.data, MANDATE_ACCOUNT_DISCRIMINATOR)) {
      return {
        valid: false,
        error: "Invalid mandate account discriminator: not a genuine SolMandate Mandate account",
      };
    }

    if (escrow.merchant.toBase58() !== merchantPubkey.toBase58()) {
      return {
        valid: false,
        error: `Escrow merchant mismatch: on-chain ${escrow.merchant.toBase58()} != expected ${merchantPubkey.toBase58()}`,
      };
    }

    // Require strict amount equality
    if (escrow.amount !== expectedAmount) {
      return {
        valid: false,
        error: `Escrow amount mismatch: on-chain ${escrow.amount} !== expected ${expectedAmount}`,
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

export interface FacilitatorConfig {
  connection?: Connection;
  rpcUrl?: string;
  network?: string;
  supportedNetworks?: string[];
  programId?: PublicKey;
  intentStore?: IPaymentIntentStore;
}

export function createFacilitatorApp(config: FacilitatorConfig = {}) {
  const app = new Hono();

  const connection =
    config.connection ||
    new Connection(
      config.rpcUrl || process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899",
      "confirmed"
    );

  const configuredNetwork = config.network || process.env.SOLANA_NETWORK || "solana:devnet";
  const supportedNetworks = config.supportedNetworks || [configuredNetwork];
  const programId = config.programId || new PublicKey(SOLMANDATE_PROGRAM_ID);
  const intentStore = config.intentStore || new MemoryPaymentIntentStore();

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      service: "SolMandate Facilitator",
      network: configuredNetwork,
      supportedNetworks,
      supportedSchemes: ["exact", "escrow"],
      uptime: process.uptime(),
    });
  });

  // Merchant registers payment intent
  app.post("/intents", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    if (!body.intentId || !body.scheme || !body.asset || !body.amount || !body.payTo) {
      return c.json(
        { success: false, error: "Missing required intent fields (intentId, scheme, asset, amount, payTo)" },
        400
      );
    }

    const net = body.network || configuredNetwork;
    if (net !== configuredNetwork && !supportedNetworks.includes(net)) {
      return c.json(
        { success: false, error: `Network mismatch: ${net} is not supported by this facilitator` },
        400
      );
    }

    const intent: PaymentIntent = {
      intentId: body.intentId,
      scheme: body.scheme,
      network: net,
      asset: body.asset,
      amount: body.amount.toString(),
      payTo: body.payTo,
      offerHash: body.offerHash,
      resource: body.resource,
      maxTimeoutSeconds: body.maxTimeoutSeconds,
      createdAt: body.createdAt || Date.now(),
      expiresAt: body.expiresAt || Date.now() + 3600 * 1000,
    };

    await intentStore.createIntent(intent);
    return c.json({ success: true, intentId: intent.intentId }, 201);
  });

  app.post("/verify", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ valid: false, error: "Invalid JSON body" }, 400);
    }

    const intentId =
      body.intentId ||
      body.payment?.intentId ||
      body.requirements?.extra?.intentId ||
      body.requirements?.intentId;

    let scheme = body.scheme || body.accepted?.scheme;
    const payment = body.payment || body.payload;
    let requirements = body.requirements || body.accepted;

    // Network validation
    const requestedNetwork = body.network || requirements?.network;
    if (
      requestedNetwork &&
      requestedNetwork !== configuredNetwork &&
      !supportedNetworks.includes(requestedNetwork)
    ) {
      return c.json(
        {
          valid: false,
          error: `Network mismatch: requested network '${requestedNetwork}' is not supported by this facilitator (configured: ${configuredNetwork})`,
        },
        400
      );
    }

    // Intent binding: if intentId is supplied, retrieve and strictly enforce the registered intent
    let matchedIntent: PaymentIntent | undefined;
    if (intentId) {
      matchedIntent = await intentStore.getIntent(intentId);
      if (!matchedIntent) {
        return c.json(
          { valid: false, error: `Payment intent '${intentId}' not found or expired` },
          400
        );
      }
      scheme = matchedIntent.scheme;
      requirements = {
        amount: matchedIntent.amount,
        asset: matchedIntent.asset,
        payTo: matchedIntent.payTo,
        extra: {
          offerHash: matchedIntent.offerHash,
          intentId: matchedIntent.intentId,
        },
      };
    }

    if (!scheme || !payment || !requirements) {
      return c.json(
        { valid: false, error: "Missing required fields: scheme, payment, requirements" },
        400
      );
    }

    if (scheme === "exact") {
      const signature = payment.signature || payment;
      if (typeof signature !== "string" || !signature) {
        return c.json({ valid: false, error: "Missing or invalid payment signature" }, 400);
      }

      // Replay prevention check
      if (await intentStore.isSettled(signature)) {
        return c.json(
          {
            valid: false,
            error: `Payment signature ${signature} has already been settled (replay detected)`,
          },
          400
        );
      }
      if (intentId && (await intentStore.isIntentFulfilled(intentId))) {
        return c.json(
          { valid: false, error: `Payment intent ${intentId} has already been fulfilled` },
          400
        );
      }

      const expectedAmount = BigInt(requirements.amount || "0");
      const expectedMint = new PublicKey(requirements.asset);
      const merchantPubkey = new PublicKey(requirements.payTo);

      const result = await verifyExactPayment(
        connection,
        signature,
        expectedAmount,
        expectedMint,
        merchantPubkey
      );

      if (!result.valid) {
        return c.json(result, 400);
      }

      // Record settlement to prevent replay
      const recordRes = await intentStore.recordSettlement(signature, intentId);
      if (!recordRes.success) {
        return c.json({ valid: false, error: recordRes.error }, 400);
      }

      return c.json(result, 200);
    } else if (scheme === "escrow") {
      const escrowPdaStr = payment.escrowPda || payment;
      if (typeof escrowPdaStr !== "string" || !escrowPdaStr) {
        return c.json({ valid: false, error: "Missing or invalid escrowPda" }, 400);
      }

      // Replay prevention check on escrow PDA
      if (await intentStore.isSettled(escrowPdaStr)) {
        return c.json(
          {
            valid: false,
            error: `Escrow account ${escrowPdaStr} has already been settled (replay detected)`,
          },
          400
        );
      }
      if (intentId && (await intentStore.isIntentFulfilled(intentId))) {
        return c.json(
          { valid: false, error: `Payment intent ${intentId} has already been fulfilled` },
          400
        );
      }

      const escrowPda = new PublicKey(escrowPdaStr);
      const expectedAmount = BigInt(requirements.amount || "0");
      const expectedOfferHash =
        requirements.extra?.offerHash ||
        requirements.offerHash ||
        hashBytesToHex(`job:audit_verification:/api/data/escrow:${requirements.amount}`);
      const merchantPubkey = new PublicKey(requirements.payTo);

      const result = await verifyEscrowAccount(
        connection,
        escrowPda,
        expectedAmount,
        expectedOfferHash,
        merchantPubkey,
        programId
      );

      if (!result.valid) {
        return c.json(
          {
            valid: false,
            error: result.error,
          },
          400
        );
      }

      // Record settlement to prevent replay
      const recordRes = await intentStore.recordSettlement(escrowPdaStr, intentId);
      if (!recordRes.success) {
        return c.json({ valid: false, error: recordRes.error }, 400);
      }

      return c.json(
        {
          valid: true,
          escrow: result.escrow
            ? {
                paymentId: Buffer.from(result.escrow.paymentId).toString("hex"),
                mandate: result.escrow.mandate.toBase58(),
                merchant: result.escrow.merchant.toBase58(),
                amount: result.escrow.amount.toString(),
                offerHash: Buffer.from(result.escrow.offerHash).toString("hex"),
                deliveryHash: Buffer.from(result.escrow.deliveryHash).toString("hex"),
                deadline: result.escrow.deadline.toString(),
                state: result.escrow.state,
                bump: result.escrow.bump,
              }
            : undefined,
        },
        200
      );
    } else {
      return c.json({ valid: false, error: `Unsupported scheme: ${scheme}` }, 400);
    }
  });

  return app;
}

if (typeof require !== "undefined" && require.main === module) {
  const port = Number(process.env.PORT) || 4021;
  const app = createFacilitatorApp();
  console.log(`🚀 SolMandate Facilitator listening on http://localhost:${port}`);
  serve({
    fetch: app.fetch,
    port,
  });
}
