import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { hashBytesToHex } from "@solmandate/verifier";

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

    return {
      valid: true,
      txDetails: {
        slot: tx.slot,
        blockTime: tx.blockTime,
        receivedAmount: receivedAmount.toString(),
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

export interface FacilitatorConfig {
  connection?: Connection;
  rpcUrl?: string;
  supportedNetworks?: string[];
}

export function createFacilitatorApp(config: FacilitatorConfig = {}) {
  const app = new Hono();

  const connection =
    config.connection ||
    new Connection(
      config.rpcUrl || process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899",
      "confirmed"
    );

  const supportedNetworks = config.supportedNetworks || [
    "solana:localnet",
    "solana:devnet",
    "solana:mainnet",
  ];

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      service: "SolMandate Facilitator",
      supportedNetworks,
      supportedSchemes: ["exact", "escrow"],
      uptime: process.uptime(),
    });
  });

  app.post("/verify", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ valid: false, error: "Invalid JSON body" }, 400);
    }

    const scheme = body.scheme || body.accepted?.scheme;
    const payment = body.payment || body.payload;
    const requirements = body.requirements || body.accepted;

    if (!scheme || !payment || !requirements) {
      return c.json(
        { valid: false, error: "Missing required fields: scheme, payment, requirements" },
        400
      );
    }

    if (scheme === "exact") {
      const signature = payment.signature || payment;
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

      return c.json(result, result.valid ? 200 : 400);
    } else if (scheme === "escrow") {
      const escrowPdaStr = payment.escrowPda || payment;
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
        merchantPubkey
      );

      return c.json(
        {
          valid: result.valid,
          error: result.error,
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
        result.valid ? 200 : 400
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
