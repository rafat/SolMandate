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

describe("SolMandate On-Chain Protocol Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.solmandate as Program<Solmandate>;

  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const merchant = Keypair.generate();
  const unauthorizedMerchant = Keypair.generate();

  let tokenMint: PublicKey;
  let ownerTokenAccount: PublicKey;
  let merchantTokenAccount: PublicKey;

  let vaultPda: PublicKey;
  let tokenVaultPda: PublicKey;
  let mandatePda: PublicKey;

  const taskId = Array.from(crypto.createHash("sha256").update("research-task-001").digest());
  const totalBudget = new anchor.BN(5_000_000); // 5 USDC (6 decimals)
  const maxPayment = new anchor.BN(1_000_000);  // 1 USDC
  const maxPurchases = 10;
  const approvalThreshold = new anchor.BN(2_000_000); // 2 USDC
  const expiresAt = new anchor.BN(Math.floor(Date.now() / 1000) + 86400); // 24h

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [owner, agent, merchant, unauthorizedMerchant]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create test USDC mint
    tokenMint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      6
    );

    // Create token accounts
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

    // Mint 100 USDC to owner
    await mintTo(
      provider.connection,
      owner,
      tokenMint,
      ownerTokenAccount,
      owner,
      100_000_000
    );

    // Derive PDAs
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
  });

  it("1. Initializes Vault with owner and agent", async () => {
    await program.methods
      .createVault()
      .accounts({
        owner: owner.publicKey,
        agent: agent.publicKey,
        tokenMint: tokenMint,
        vault: vaultPda,
        tokenVault: tokenVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    expect(vaultAccount.owner.toBase58()).to.equal(owner.publicKey.toBase58());
    expect(vaultAccount.agent.toBase58()).to.equal(agent.publicKey.toBase58());
    expect(vaultAccount.isPaused).to.be.false;
  });

  it("2. Funds the Vault with 10 USDC", async () => {
    const depositAmount = new anchor.BN(10_000_000);

    await program.methods
      .deposit(depositAmount)
      .accounts({
        funder: owner.publicKey,
        vault: vaultPda,
        tokenMint: tokenMint,
        tokenVault: tokenVaultPda,
        funderTokenAccount: ownerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();

    const vaultTokenAccount = await getAccount(provider.connection, tokenVaultPda);
    expect(Number(vaultTokenAccount.amount)).to.equal(10_000_000);
  });

  it("3. Creates a task-scoped Mandate", async () => {
    await program.methods
      .createMandate(
        taskId,
        totalBudget,
        maxPayment,
        maxPurchases,
        approvalThreshold,
        expiresAt,
        [merchant.publicKey] // allowlist: only merchant
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const mandate = await program.account.mandate.fetch(mandatePda);
    expect(mandate.totalBudget.toNumber()).to.equal(5_000_000);
    expect(mandate.reservedAmount.toNumber()).to.equal(0);
    expect(mandate.settledAmount.toNumber()).to.equal(0);
    expect(mandate.purchaseCount).to.equal(0);
  });

  it("4. Mode 1: Agent executes pay_exact (0.50 USDC) to whitelisted merchant", async () => {
    const paymentAmount = new anchor.BN(500_000);

    await program.methods
      .payExact(paymentAmount)
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        tokenMint: tokenMint,
        tokenVault: tokenVaultPda,
        merchant: merchant.publicKey,
        merchantTokenAccount: merchantTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agent])
      .rpc();

    const merchantAta = await getAccount(provider.connection, merchantTokenAccount);
    expect(Number(merchantAta.amount)).to.equal(500_000);

    const mandate = await program.account.mandate.fetch(mandatePda);
    expect(mandate.settledAmount.toNumber()).to.equal(500_000);
    expect(mandate.purchaseCount).to.equal(1);
  });

  it("5. Guardrail: Blocks payment exceeding payment cap", async () => {
    const excessiveAmount = new anchor.BN(1_500_000); // cap is 1.00 USDC

    try {
      await program.methods
        .payExact(excessiveAmount)
        .accounts({
          agent: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          tokenMint: tokenMint,
          tokenVault: tokenVaultPda,
          merchant: merchant.publicKey,
          merchantTokenAccount: merchantTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown PaymentCapExceeded");
    } catch (err: any) {
      expect(err.message).to.include("PaymentCapExceeded");
    }
  });

  it("6. Guardrail: Blocks unauthorized merchant", async () => {
    const unauthAta = await createAssociatedTokenAccount(
      provider.connection,
      owner,
      tokenMint,
      unauthorizedMerchant.publicKey
    );

    try {
      await program.methods
        .payExact(new anchor.BN(100_000))
        .accounts({
          agent: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          tokenMint: tokenMint,
          tokenVault: tokenVaultPda,
          merchant: unauthorizedMerchant.publicKey,
          merchantTokenAccount: unauthAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown MerchantNotAllowed");
    } catch (err: any) {
      expect(err.message).to.include("MerchantNotAllowed");
    }
  });

  it("7. Mode 2: Escrow lifecycle — Reserve, Commit Delivery, and Release Payment", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("pay-001").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("offer-terms").digest());
    const deliveryHash = Array.from(crypto.createHash("sha256").update("delivery-payload-data").digest());
    const escrowAmount = new anchor.BN(400_000);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );

    // Step A: Agent reserves escrow
    await program.methods
      .requestPayment(paymentId, escrowAmount, offerHash, deadline)
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

    let mandate = await program.account.mandate.fetch(mandatePda);
    expect(mandate.reservedAmount.toNumber()).to.equal(400_000);
    expect(mandate.purchaseCount).to.equal(2);

    // Step B: Merchant commits delivery proof
    await program.methods
      .commitDelivery(deliveryHash)
      .accounts({
        merchant: merchant.publicKey,
        escrow: escrowPda,
      })
      .signers([merchant])
      .rpc();

    // Step C: Verifier / Agent confirms delivery hash and releases funds
    await program.methods
      .releasePayment(deliveryHash)
      .accounts({
        authority: agent.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        escrow: escrowPda,
        tokenMint: tokenMint,
        tokenVault: tokenVaultPda,
        merchant: merchant.publicKey,
        merchantTokenAccount: merchantTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agent])
      .rpc();

    mandate = await program.account.mandate.fetch(mandatePda);
    expect(mandate.reservedAmount.toNumber()).to.equal(0);
    expect(mandate.settledAmount.toNumber()).to.equal(900_000); // 500k + 400k

    const merchantAta = await getAccount(provider.connection, merchantTokenAccount);
    expect(Number(merchantAta.amount)).to.equal(900_000);
  });

  it("8. Mode 2: Failed delivery triggers refund and restores available budget", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("pay-002-fail").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("offer-terms-2").digest());
    const escrowAmount = new anchor.BN(300_000);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );

    // Reserve escrow
    await program.methods
      .requestPayment(paymentId, escrowAmount, offerHash, deadline)
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

    let mandate = await program.account.mandate.fetch(mandatePda);
    expect(mandate.reservedAmount.toNumber()).to.equal(300_000);

    // Delivery failed -> refund
    await program.methods
      .refundPayment()
      .accounts({
        authority: agent.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        escrow: escrowPda,
        tokenVault: tokenVaultPda,
      })
      .signers([agent])
      .rpc();

    mandate = await program.account.mandate.fetch(mandatePda);
    // Reserved amount restored to 0! Available budget is intact.
    expect(mandate.reservedAmount.toNumber()).to.equal(0);
    expect(mandate.settledAmount.toNumber()).to.equal(900_000);
  });

  it("9. Emergency Control: Pause vault blocks agent transactions", async () => {
    await program.methods
      .pauseVault()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      })
      .signers([owner])
      .rpc();

    let vault = await program.account.vault.fetch(vaultPda);
    expect(vault.isPaused).to.be.true;

    try {
      await program.methods
        .payExact(new anchor.BN(100_000))
        .accounts({
          agent: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          tokenMint: tokenMint,
          tokenVault: tokenVaultPda,
          merchant: merchant.publicKey,
          merchantTokenAccount: merchantTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown VaultPaused");
    } catch (err: any) {
      expect(err.message).to.include("VaultPaused");
    }

    // Unpause
    await program.methods
      .unpauseVault()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
      })
      .signers([owner])
      .rpc();

    vault = await program.account.vault.fetch(vaultPda);
    expect(vault.isPaused).to.be.false;
  });
});
