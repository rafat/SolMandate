import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Solmandate } from "../target/types/solmandate";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import crypto from "crypto";
import { SolMandateClient } from "../packages/sdk/src/client";
import {
  createMandateFetch,
  DeliveryVerificationError,
} from "../packages/sdk/src/fetch";
import { createMerchantApp } from "../services/merchant-api/src/index";
import { createFacilitatorApp } from "../services/facilitator/src/index";

describe("SolMandate E2E: x402 Client + Merchant + On-Chain Program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.solmandate as Program<Solmandate>;

  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const merchant = Keypair.generate();

  let tokenMint: PublicKey;
  let ownerTokenAccount: PublicKey;
  let merchantTokenAccount: PublicKey;

  let vaultPda: PublicKey;
  let tokenVaultPda: PublicKey;
  let mandatePda: PublicKey;

  const taskId = Array.from(
    crypto.createHash("sha256").update("e2e-agent-task-001").digest()
  );
  const totalBudget = new anchor.BN(15_000_000); // 15 USDC
  const maxPayment = new anchor.BN(5_000_000); // 5 USDC cap
  const maxPurchases = 20;
  const approvalThreshold = new anchor.BN(5_000_000);
  const expiresAt = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);

  let sdkClient: SolMandateClient;
  let merchantApp: ReturnType<typeof createMerchantApp>;
  let mandateFetch: ReturnType<typeof createMandateFetch>;
  let honoFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  before(async () => {
    // 1. Airdrop SOL
    for (const actor of [owner, agent, merchant]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // 2. Create test USDC Mint
    tokenMint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      6
    );

    // 3. Create ATAs
    ownerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      tokenMint,
      owner.publicKey
    );

    merchantTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      tokenMint,
      merchant.publicKey
    );

    // 4. Mint 50 USDC to owner
    await mintTo(
      provider.connection,
      owner,
      tokenMint,
      ownerTokenAccount,
      owner,
      50_000_000
    );

    // 5. Initialize Vault
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.publicKey.toBuffer()],
      program.programId
    );

    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), vaultPda.toBuffer()],
      program.programId
    );

    [mandatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mandate"), vaultPda.toBuffer(), Buffer.from(taskId)],
      program.programId
    );

    await program.methods
      .createVault()
      .accounts({
        owner: owner.publicKey,
        agent: agent.publicKey,
        tokenMint,
        vault: vaultPda,
        tokenVault: tokenVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // 6. Fund Vault with 20 USDC
    await program.methods
      .deposit(new anchor.BN(20_000_000))
      .accounts({
        funder: owner.publicKey,
        vault: vaultPda,
        tokenMint,
        tokenVault: tokenVaultPda,
        funderTokenAccount: ownerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();

    // 7. Create Mandate with merchant in allowlist
    await program.methods
      .createMandate(
        taskId,
        totalBudget,
        maxPayment,
        maxPurchases,
        approvalThreshold,
        expiresAt,
        [merchant.publicKey]
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        tokenVault: tokenVaultPda,
        mandate: mandatePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // 8. Setup SDK Client (agent signer)
    sdkClient = new SolMandateClient({
      connection: provider.connection,
      signer: agent,
      programId: program.programId,
    });

    // Setup Merchant SDK Client (merchant signer)
    const merchantClient = new SolMandateClient({
      connection: provider.connection,
      signer: merchant,
      programId: program.programId,
    });

    // 9. Setup Merchant App with connection, on-chain delivery commitment & refund handlers
    merchantApp = createMerchantApp({
      merchantPubkey: merchant.publicKey.toBase58(),
      tokenMint: tokenMint.toBase58(),
      network: "solana:localnet",
      connection: provider.connection,
      onCommitDelivery: async (escrowPdaStr: string, deliveryHashHex: string) => {
        const escrowPda = new PublicKey(escrowPdaStr);
        await merchantClient.commitDelivery({
          escrowPda,
          deliveryHash: deliveryHashHex,
        });
      },
      onRefundPayment: async (escrowPdaStr: string) => {
        const escrowPda = new PublicKey(escrowPdaStr);
        await merchantClient.refundPayment({
          mandatePda,
          escrowPda,
        });
      },
    });

    // Custom fetch calling the Hono merchant app directly
    honoFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      let req: Request;
      if (input instanceof Request) {
        req = input;
      } else {
        const urlStr = typeof input === "string" ? input : input.toString();
        req = new Request(urlStr, init);
      }
      return await merchantApp.fetch(req);
    };

    // 10. Instantiate Agent Mandate Fetch
    mandateFetch = createMandateFetch({
      client: sdkClient,
      mandatePda,
      tokenMint,
      fetch: honoFetch as any,
    });
  });

  it("1. Mode 1 (Exact): Auto-pays x402 402 response, verifies transaction on-chain, and retrieves telemetry", async () => {
    // 1a. Attempting to pass a fabricated signature directly to merchant API must fail with HTTP 402
    const fakePayload = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "solana:localnet",
        asset: tokenMint.toBase58(),
        amount: "1000000",
        payTo: merchant.publicKey.toBase58(),
      },
      payload: {
        signature: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUc",
      },
    };
    const fakeReq = new Request("http://localhost:4020/api/data/exact", {
      headers: {
        "payment-signature": Buffer.from(JSON.stringify(fakePayload)).toString("base64"),
      },
    });
    const fakeRes = await merchantApp.fetch(fakeReq);
    expect(fakeRes.status).to.equal(402);
    const fakeBody = await fakeRes.json();
    expect(fakeBody.error).to.match(/Transaction not found|verification failed/i);

    // 1b. Legitimate flow via mandateFetch succeeds
    const merchantAccountBefore = await getAccount(
      provider.connection,
      merchantTokenAccount
    );
    expect(Number(merchantAccountBefore.amount)).to.equal(0);

    const res = await mandateFetch("http://localhost:4020/api/data/exact");
    expect(res.status).to.equal(200);

    const body = await res.json();
    expect(body.success).to.be.true;
    expect(body.service).to.equal("Solana Validator Telemetry");

    // On-chain verification: merchant received 1 USDC (1_000_000)
    const merchantAccountAfter = await getAccount(
      provider.connection,
      merchantTokenAccount
    );
    expect(Number(merchantAccountAfter.amount)).to.equal(1_000_000);

    // Mandate on-chain accounting updated
    const mandateAccount = await program.account.mandate.fetch(mandatePda);
    expect(mandateAccount.settledAmount.toNumber()).to.equal(1_000_000);
    expect(mandateAccount.purchaseCount).to.equal(1);
  });

  it("2. Mode 2 (Escrow): Reserves funds, verifies outcome hash, and settles payment", async () => {
    const merchantAccountBefore = await getAccount(
      provider.connection,
      merchantTokenAccount
    );
    const balanceBefore = Number(merchantAccountBefore.amount);

    const res = await mandateFetch("http://localhost:4020/api/data/escrow");
    expect(res.status).to.equal(200);

    const body = await res.json();
    expect(body.success).to.be.true;
    expect(body.service).to.equal("AI Smart Contract Audit & Sanitization Report");

    // Merchant received the 2 USDC payment upon successful release
    const merchantAccountAfter = await getAccount(
      provider.connection,
      merchantTokenAccount
    );
    expect(Number(merchantAccountAfter.amount) - balanceBefore).to.equal(2_000_000);

    // Mandate on-chain accounting updated
    const mandateAccount = await program.account.mandate.fetch(mandatePda);
    expect(mandateAccount.settledAmount.toNumber()).to.equal(3_000_000); // 1 + 2 = 3 USDC
    expect(mandateAccount.reservedAmount.toNumber()).to.equal(0); // Reserved restored to 0 after settlement
  });

  it("3. Mode 2 (Failure & Auto-Refund): Faulty delivery triggers on-chain refund and restores budget", async () => {
    const mandateBefore = await program.account.mandate.fetch(mandatePda);
    const settledBefore = mandateBefore.settledAmount.toNumber();
    const reservedBefore = mandateBefore.reservedAmount.toNumber();

    // Call endpoint with simulated failure
    const res = await mandateFetch(
      "http://localhost:4020/api/data/escrow?simulate=failure"
    );
    expect(res.status).to.equal(500);

    // Mandate budget check: NO funds were settled to the merchant!
    const mandateAfter = await program.account.mandate.fetch(mandatePda);
    expect(mandateAfter.settledAmount.toNumber()).to.equal(settledBefore);
    expect(mandateAfter.reservedAmount.toNumber()).to.equal(reservedBefore); // Restored!
  });

  it("4. Fails closed on unsupported scheme (returns 402, no on-chain payment)", async () => {
    const mandateBefore = await program.account.mandate.fetch(mandatePda);
    const settledBefore = mandateBefore.settledAmount.toNumber();

    const res = await mandateFetch("http://localhost:4020/api/data/unsupported");
    expect(res.status).to.equal(402);

    // Verify no funds settled
    const mandateAfter = await program.account.mandate.fetch(mandatePda);
    expect(mandateAfter.settledAmount.toNumber()).to.equal(settledBefore);
  });

  it("5. Custom request headers, Request instance, and POST bodies are preserved across 402 retry", async () => {
    // 5a. Custom header on GET
    const traceId = "agent-trace-req-999";
    const res = await mandateFetch("http://localhost:4020/api/data/exact", {
      headers: {
        "x-agent-trace": traceId,
      },
    });
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.success).to.be.true;
    expect(body.agentTrace).to.equal(traceId);

    // 5b. Request instance input
    const reqInstance = new Request("http://localhost:4020/api/data/exact", {
      headers: {
        "x-agent-trace": "request-instance-trace-888",
      },
    });
    const resFromReq = await mandateFetch(reqInstance);
    expect(resFromReq.status).to.equal(200);
    const bodyFromReq = await resFromReq.json();
    expect(bodyFromReq.agentTrace).to.equal("request-instance-trace-888");

    // 5c. POST body and custom headers preservation across 402 challenge
    const postPayload = JSON.stringify({ query: "compute_clusters", tier: "pro" });
    const postRes = await mandateFetch("http://localhost:4020/api/data/post-echo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-custom-post-header": "echo-test-header-123",
      },
      body: postPayload,
    });
    expect(postRes.status).to.equal(200);
    const postJson = await postRes.json();
    expect(postJson.success).to.be.true;
    expect(postJson.echoedBody).to.equal(postPayload);
    expect(postJson.echoedHeader).to.equal("echo-test-header-123");
  });

  it("6. Delivery hash mismatch aborts payment release, throws DeliveryVerificationError, and protects funds", async () => {
    let verificationStatus: string = "";
    let verificationError: string = "";

    const trackedFetch = createMandateFetch({
      client: sdkClient,
      mandatePda,
      tokenMint,
      fetch: honoFetch as any,
      onDeliveryVerified: (evt) => {
        verificationStatus = evt.status;
        verificationError = evt.error || "";
      },
    });

    const mandateBefore = await program.account.mandate.fetch(mandatePda);
    const settledBefore = mandateBefore.settledAmount.toNumber();

    try {
      await trackedFetch(
        "http://localhost:4020/api/data/escrow?simulate=corrupt_data"
      );
      expect.fail("Should have thrown DeliveryVerificationError");
    } catch (err: any) {
      expect(err).to.be.instanceOf(DeliveryVerificationError);
      expect(err.message).to.include("Hash mismatch");
      expect(err.actualHash).to.be.a("string");
      expect(err.committedHash).to.be.a("string");
    }

    // Verification failed event emitted due to hash mismatch
    expect(verificationStatus).to.equal("verification_failed");
    expect(verificationError).to.include("Hash mismatch");

    // Crucial on-chain check: payment was NOT released! Settled amount did not increase!
    const mandateAfter = await program.account.mandate.fetch(mandatePda);
    expect(mandateAfter.settledAmount.toNumber()).to.equal(settledBefore);
  });

  it("7. Client strictly rejects invalid requirements (network, cap) without submitting transaction", async () => {
    const strictFetch = createMandateFetch({
      client: sdkClient,
      mandatePda,
      tokenMint,
      allowedNetworks: ["solana:mainnet-beta"], // localnet is not allowed
      fetch: honoFetch as any,
    });

    try {
      await strictFetch("http://localhost:4020/api/data/exact");
      expect.fail("Should have rejected disallowed network");
    } catch (err: any) {
      expect(err.message).to.include("Network 'solana:localnet' is not permitted");
    }

    const cappedFetch = createMandateFetch({
      client: sdkClient,
      mandatePda,
      tokenMint,
      maxPaymentAmount: 500_000n, // less than 1_000_000 required
      fetch: honoFetch as any,
    });

    try {
      await cappedFetch("http://localhost:4020/api/data/exact");
      expect.fail("Should have rejected exceeding cap");
    } catch (err: any) {
      expect(err.message).to.include("exceeds client configured max payment amount");
    }
  });

  it("8. Merchant rejects escrow with mismatched offer hash before committing delivery", async () => {
    const bogusOfferHash = Array.from(crypto.createHash("sha256").update("bogus-offer").digest());
    const paymentId = Array.from(crypto.createHash("sha256").update("test-bogus-escrow").digest());
    const amount = new anchor.BN(2_000_000);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [bogusEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );

    await program.methods
      .requestPayment(paymentId, amount, bogusOfferHash, deadline)
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        merchant: merchant.publicKey,
        escrow: bogusEscrowPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    // Present this escrow to merchant escrow endpoint
    const bogusPayload = {
      x402Version: 2,
      accepted: {
        scheme: "escrow",
        network: "solana:localnet",
        asset: tokenMint.toBase58(),
        amount: "2000000",
        payTo: merchant.publicKey.toBase58(),
      },
      payload: {
        escrowPda: bogusEscrowPda.toBase58(),
      },
    };

    const bogusReq = new Request("http://localhost:4020/api/data/escrow", {
      headers: {
        "payment-signature": Buffer.from(JSON.stringify(bogusPayload)).toString("base64"),
      },
    });

    const bogusRes = await merchantApp.fetch(bogusReq);
    expect(bogusRes.status).to.equal(400);
    const body = await bogusRes.json();
    expect(body.error).to.include("Escrow offer hash mismatch");
  });

  it("9. Facilitator service verifies exact on-chain payments and rejects unconfirmed/invalid transactions", async () => {
    const facilitatorApp = createFacilitatorApp({
      connection: provider.connection,
    });

    // 9a. Verify health check
    const healthRes = await facilitatorApp.fetch(new Request("http://localhost:4021/health"));
    expect(healthRes.status).to.equal(200);
    const healthBody = await healthRes.json();
    expect(healthBody.service).to.equal("SolMandate Facilitator");
    expect(healthBody.supportedSchemes).to.deep.equal(["exact", "escrow"]);

    // 9b. Rejection of unconfirmed or fabricated signature
    const invalidVerifyReq = new Request("http://localhost:4021/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheme: "exact",
        payment: { signature: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUc" },
        requirements: {
          amount: "1000000",
          asset: tokenMint.toBase58(),
          payTo: merchant.publicKey.toBase58(),
        },
      }),
    });
    const invalidVerifyRes = await facilitatorApp.fetch(invalidVerifyReq);
    expect(invalidVerifyRes.status).to.equal(400);
    const invalidBody = await invalidVerifyRes.json();
    expect(invalidBody.valid).to.be.false;
    expect(invalidBody.error).to.include("Transaction not found");

    // 9c. Legitimate exact payment execution & facilitator verification
    const exactPaymentId = Array.from(crypto.createHash("sha256").update("facilitator-exact-test").digest());
    const validTxSig = await sdkClient.payExact({
      mandatePda,
      merchant: merchant.publicKey,
      merchantTokenAccount,
      amount: 1_000_000n,
      paymentId: exactPaymentId,
    });

    await provider.connection.confirmTransaction(validTxSig, "confirmed");

    const validVerifyReq = new Request("http://localhost:4021/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheme: "exact",
        payment: { signature: validTxSig },
        requirements: {
          amount: "1000000",
          asset: tokenMint.toBase58(),
          payTo: merchant.publicKey.toBase58(),
        },
      }),
    });
    const validVerifyRes = await facilitatorApp.fetch(validVerifyReq);
    expect(validVerifyRes.status).to.equal(200);
    const validBody = await validVerifyRes.json();
    expect(validBody.valid).to.be.true;
    expect(validBody.txDetails.merchant).to.equal(merchant.publicKey.toBase58());
  });

  it("10. Facilitator service verifies on-chain escrow account invariants", async () => {
    const facilitatorApp = createFacilitatorApp({
      connection: provider.connection,
    });

    const paymentId = Array.from(crypto.createHash("sha256").update("facilitator-escrow-test").digest());
    const offerHashHex = "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff";
    const offerHash = Array.from(Buffer.from(offerHashHex, "hex"));
    const amount = new anchor.BN(1_500_000);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );

    await program.methods
      .requestPayment(paymentId, amount, offerHash, deadline)
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        merchant: merchant.publicKey,
        escrow: escrowPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    // Verify valid escrow via facilitator
    const validEscrowReq = new Request("http://localhost:4021/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheme: "escrow",
        payment: { escrowPda: escrowPda.toBase58() },
        requirements: {
          amount: "1500000",
          asset: tokenMint.toBase58(),
          payTo: merchant.publicKey.toBase58(),
          extra: { offerHash: offerHashHex },
        },
      }),
    });
    const validRes = await facilitatorApp.fetch(validEscrowReq);
    expect(validRes.status).to.equal(200);
    const validBody = await validRes.json();
    expect(validBody.valid).to.be.true;
    expect(validBody.escrow.state).to.equal("Held");

    // Verify rejection when expected offer hash does not match
    const mismatchReq = new Request("http://localhost:4021/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheme: "escrow",
        payment: { escrowPda: escrowPda.toBase58() },
        requirements: {
          amount: "1500000",
          asset: tokenMint.toBase58(),
          payTo: merchant.publicKey.toBase58(),
          extra: { offerHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
        },
      }),
    });
    const mismatchRes = await facilitatorApp.fetch(mismatchReq);
    expect(mismatchRes.status).to.equal(400);
    const mismatchBody = await mismatchRes.json();
    expect(mismatchBody.valid).to.be.false;
    expect(mismatchBody.error).to.include("Escrow offer hash mismatch");
  });
});
