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
import { createMandateFetch } from "../packages/sdk/src/fetch";
import { createMerchantApp } from "../services/merchant-api/src/index";

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
  const totalBudget = new anchor.BN(10_000_000); // 10 USDC
  const maxPayment = new anchor.BN(3_000_000); // 3 USDC cap
  const maxPurchases = 20;
  const approvalThreshold = new anchor.BN(5_000_000);
  const expiresAt = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);

  let sdkClient: SolMandateClient;
  let merchantApp: ReturnType<typeof createMerchantApp>;
  let mandateFetch: ReturnType<typeof createMandateFetch>;

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

    // 9. Setup Merchant App
    merchantApp = createMerchantApp({
      merchantPubkey: merchant.publicKey.toBase58(),
      tokenMint: tokenMint.toBase58(),
      network: "solana:localnet",
    });

    // Custom fetch calling the Hono merchant app directly
    const honoFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === "string" ? input : input.toString();
      const req = new Request(urlStr, init);
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

  it("1. Mode 1 (Exact): Auto-pays x402 402 response and retrieves telemetry", async () => {
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
});
