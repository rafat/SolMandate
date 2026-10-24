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

describe("SolMandate Adversarial Security & Invariant Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.solmandate as Program<Solmandate>;

  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const attacker = Keypair.generate();
  const merchant = Keypair.generate();

  let tokenMint: PublicKey;
  let ownerTokenAccount: PublicKey;
  let merchantTokenAccount: PublicKey;

  let vaultPda: PublicKey;
  let tokenVaultPda: PublicKey;
  let mandatePda: PublicKey;

  const taskId = Array.from(crypto.createHash("sha256").update("task-adversarial-001").digest());
  const totalBudget = new anchor.BN(5_000_000); // 5 USDC
  const maxPayment = new anchor.BN(2_000_000); // 2 USDC
  const maxPurchases = 10;
  const approvalThreshold = new anchor.BN(3_000_000);
  const expiresAt = new anchor.BN(Math.floor(Date.now() / 1000) + 7200);

  before(async () => {
    // 1. Airdrop SOL
    for (const actor of [owner, agent, attacker, merchant]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // 2. Create Mint & Token Accounts
    tokenMint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      6
    );

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

    // Mint 50 USDC to owner
    await mintTo(
      provider.connection,
      owner,
      tokenMint,
      ownerTokenAccount,
      owner,
      50_000_000
    );

    // 3. Derive PDAs
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

    // 4. Initialize Vault
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

    // 5. Deposit 10 USDC into Vault
    await program.methods
      .deposit(new anchor.BN(10_000_000))
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

    // 6. Create initial Mandate with 5 USDC budget
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
  });

  it("ADV-1: Releasing escrow while in Held state is STRICTLY REJECTED", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-held-release").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("adv-offer-1").digest());
    const amount = new anchor.BN(500_000);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );

    // Agent reserves escrow (State = Held)
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

    const dummyHash = Array.from(crypto.createHash("sha256").update("dummy").digest());

    // Agent attempts to release without merchant commitDelivery
    try {
      await program.methods
        .releasePayment(dummyHash)
        .accounts({
          authority: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          escrow: escrowPda,
          tokenMint,
          tokenVault: tokenVaultPda,
          merchant: merchant.publicKey,
          merchantTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown InvalidEscrowState");
    } catch (err: any) {
      expect(err.message).to.include("InvalidEscrowState");
    }

    // Even owner cannot release while in Held state
    try {
      await program.methods
        .releasePayment(dummyHash)
        .accounts({
          authority: owner.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          escrow: escrowPda,
          tokenMint,
          tokenVault: tokenVaultPda,
          merchant: merchant.publicKey,
          merchantTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();
      expect.fail("Should have thrown InvalidEscrowState");
    } catch (err: any) {
      expect(err.message).to.include("InvalidEscrowState");
    }
  });

  it("ADV-2: Committing zero delivery hash is REJECTED", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-zero-hash").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("adv-offer-2").digest());
    const amount = new anchor.BN(500_000);
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

    const zeroHash = new Array(32).fill(0);

    try {
      await program.methods
        .commitDelivery(zeroHash)
        .accounts({
          merchant: merchant.publicKey,
          escrow: escrowPda,
        })
        .signers([merchant])
        .rpc();
      expect.fail("Should have thrown MissingDeliveryCommitment");
    } catch (err: any) {
      expect(err.message).to.include("MissingDeliveryCommitment");
    }
  });

  it("ADV-3: Releasing payment with mismatched delivery hash is REJECTED", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-hash-mismatch").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("adv-offer-3").digest());
    const amount = new anchor.BN(500_000);
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

    const committedHash = Array.from(crypto.createHash("sha256").update("correct-payload").digest());
    const tamperedHash = Array.from(crypto.createHash("sha256").update("tampered-payload").digest());

    // Merchant commits genuine hash
    await program.methods
      .commitDelivery(committedHash)
      .accounts({
        merchant: merchant.publicKey,
        escrow: escrowPda,
      })
      .signers([merchant])
      .rpc();

    // Release with wrong hash must fail
    try {
      await program.methods
        .releasePayment(tamperedHash)
        .accounts({
          authority: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          escrow: escrowPda,
          tokenMint,
          tokenVault: tokenVaultPda,
          merchant: merchant.publicKey,
          merchantTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown DeliveryHashMismatch");
    } catch (err: any) {
      expect(err.message).to.include("DeliveryHashMismatch");
    }

    // Release with genuine hash succeeds
    await program.methods
      .releasePayment(committedHash)
      .accounts({
        authority: agent.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        escrow: escrowPda,
        tokenMint,
        tokenVault: tokenVaultPda,
        merchant: merchant.publicKey,
        merchantTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agent])
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPda);
    expect(escrow.state).to.deep.equal({ released: {} });
  });

  it("ADV-4: Vault liability invariant prevents overcommitting vault across mandates", async () => {
    // Current vault deposit: 10 USDC. Mandate 1 allocated: 5 USDC.
    // Available unallocated vault funds: 5 USDC.

    // Mandate 2 requesting 6 USDC (5 + 6 = 11 > 10) must FAIL
    const taskId2 = Array.from(crypto.createHash("sha256").update("task-overcommit-test").digest());
    const [mandatePda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("mandate"), vaultPda.toBuffer(), Buffer.from(taskId2)],
      program.programId
    );

    try {
      await program.methods
        .createMandate(
          taskId2,
          new anchor.BN(6_000_000), // 6 USDC
          new anchor.BN(1_000_000),
          5,
          new anchor.BN(1_000_000),
          expiresAt,
          []
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          tokenVault: tokenVaultPda,
          mandate: mandatePda2,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      expect.fail("Should have thrown VaultOvercommitted");
    } catch (err: any) {
      expect(err.message).to.include("VaultOvercommitted");
    }

    // Mandate 2 requesting exactly 5 USDC (5 + 5 = 10 == 10) must SUCCEED
    await program.methods
      .createMandate(
        taskId2,
        new anchor.BN(5_000_000), // exactly 5 USDC
        new anchor.BN(1_000_000),
        5,
        new anchor.BN(1_000_000),
        expiresAt,
        []
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        tokenVault: tokenVaultPda,
        mandate: mandatePda2,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // Mandate 3 requesting even 1 lamport must FAIL as vault is fully allocated
    const taskId3 = Array.from(crypto.createHash("sha256").update("task-overcommit-3").digest());
    const [mandatePda3] = PublicKey.findProgramAddressSync(
      [Buffer.from("mandate"), vaultPda.toBuffer(), Buffer.from(taskId3)],
      program.programId
    );

    try {
      await program.methods
        .createMandate(
          taskId3,
          new anchor.BN(1), // 1 unit
          new anchor.BN(1),
          5,
          new anchor.BN(1),
          expiresAt,
          []
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          tokenVault: tokenVaultPda,
          mandate: mandatePda3,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      expect.fail("Should have thrown VaultOvercommitted");
    } catch (err: any) {
      expect(err.message).to.include("VaultOvercommitted");
    }
  });

  it("ADV-5: Terminal state invariant prevents double settlement and release after refund", async () => {
    // 1. Double release test on the released escrow from ADV-3
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-hash-mismatch").digest());
    const [releasedEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );
    const committedHash = Array.from(crypto.createHash("sha256").update("correct-payload").digest());

    try {
      await program.methods
        .releasePayment(committedHash)
        .accounts({
          authority: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          escrow: releasedEscrowPda,
          tokenMint,
          tokenVault: tokenVaultPda,
          merchant: merchant.publicKey,
          merchantTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have rejected second release");
    } catch (err: any) {
      expect(err.message).to.include("InvalidEscrowState");
    }

    // 2. Refunding an already released escrow must fail
    try {
      await program.methods
        .refundPayment()
        .accounts({
          authority: merchant.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          escrow: releasedEscrowPda,
          tokenVault: tokenVaultPda,
        })
        .signers([merchant])
        .rpc();
      expect.fail("Should have rejected refund on released escrow");
    } catch (err: any) {
      expect(err.message).to.include("InvalidEscrowState");
    }

    // 3. Releasing an already refunded escrow must fail
    const paymentIdRefund = Array.from(crypto.createHash("sha256").update("adv-refund-double").digest());
    const [refundEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(paymentIdRefund)],
      program.programId
    );

    await program.methods
      .requestPayment(paymentIdRefund, new anchor.BN(200_000), committedHash, expiresAt)
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        merchant: merchant.publicKey,
        escrow: refundEscrowPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    // Merchant refunds it
    await program.methods
      .refundPayment()
      .accounts({
        authority: merchant.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        escrow: refundEscrowPda,
        tokenVault: tokenVaultPda,
      })
      .signers([merchant])
      .rpc();

    // Now trying to release must fail
    try {
      await program.methods
        .releasePayment(committedHash)
        .accounts({
          authority: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          escrow: refundEscrowPda,
          tokenMint,
          tokenVault: tokenVaultPda,
          merchant: merchant.publicKey,
          merchantTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have rejected release on refunded escrow");
    } catch (err: any) {
      expect(err.message).to.include("InvalidEscrowState");
    }
  });

  it("ADV-6: Agent cannot unilaterally cancel/refund escrow without merchant or owner", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-unauth-refund").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("adv-offer-unauth").digest());
    const amount = new anchor.BN(300_000);
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

    // Agent attempts to call refundPayment
    try {
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
      expect.fail("Should have thrown Unauthorized for agent calling refund");
    } catch (err: any) {
      expect(err.message).to.include("Unauthorized");
    }

    // Arbitrary attacker attempts to call refundPayment
    try {
      await program.methods
        .refundPayment()
        .accounts({
          authority: attacker.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          escrow: escrowPda,
          tokenVault: tokenVaultPda,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown Unauthorized for attacker");
    } catch (err: any) {
      expect(err.message).to.include("Unauthorized");
    }

    // Owner CAN call refundPayment (dispute resolution)
    await program.methods
      .refundPayment()
      .accounts({
        authority: owner.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        escrow: escrowPda,
        tokenVault: tokenVaultPda,
      })
      .signers([owner])
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPda);
    expect(escrow.state).to.deep.equal({ refunded: {} });
  });

  it("ADV-7: Claim after timeout requires elapsed deadline and cannot claim Delivered escrow", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-timeout-test").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("adv-offer-timeout").digest());
    const amount = new anchor.BN(300_000);
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour in future

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

    // Calling claimAfterTimeout before deadline must fail with TimeoutNotReached
    try {
      await program.methods
        .claimAfterTimeout()
        .accounts({
          authority: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          escrow: escrowPda,
          tokenVault: tokenVaultPda,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown TimeoutNotReached");
    } catch (err: any) {
      expect(err.message).to.include("TimeoutNotReached");
    }

    // Merchant commits delivery (State = Delivered)
    const delivHash = Array.from(crypto.createHash("sha256").update("deliv-proof").digest());
    await program.methods
      .commitDelivery(delivHash)
      .accounts({
        merchant: merchant.publicKey,
        escrow: escrowPda,
      })
      .signers([merchant])
      .rpc();

    // Even if timeout passed, claiming timeout on Delivered escrow must fail with InvalidEscrowState
    try {
      await program.methods
        .claimAfterTimeout()
        .accounts({
          authority: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          escrow: escrowPda,
          tokenVault: tokenVaultPda,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have rejected timeout claim on delivered escrow");
    } catch (err: any) {
      expect(err.message).to.include("InvalidEscrowState");
    }
  });

  it("ADV-8: Zero-amount and parameter boundary validation checks", async () => {
    // 1. payExact amount == 0
    try {
      await program.methods
        .payExact(new anchor.BN(0))
        .accounts({
          agent: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          tokenMint,
          tokenVault: tokenVaultPda,
          merchant: merchant.publicKey,
          merchantTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have rejected zero payment");
    } catch (err: any) {
      expect(err.message).to.include("InvalidAmount");
    }

    // 2. requestPayment amount == 0
    const zeroPayId = Array.from(crypto.createHash("sha256").update("adv-zero-pay").digest());
    const [zeroEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(zeroPayId)],
      program.programId
    );

    try {
      await program.methods
        .requestPayment(zeroPayId, new anchor.BN(0), zeroPayId, expiresAt)
        .accounts({
          agent: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          merchant: merchant.publicKey,
          escrow: zeroEscrowPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have rejected zero escrow amount");
    } catch (err: any) {
      expect(err.message).to.include("InvalidAmount");
    }

    // 3. requestPayment with past deadline
    try {
      await program.methods
        .requestPayment(zeroPayId, new anchor.BN(100_000), zeroPayId, new anchor.BN(1000))
        .accounts({
          agent: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          merchant: merchant.publicKey,
          escrow: zeroEscrowPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have rejected past deadline");
    } catch (err: any) {
      expect(err.message).to.include("InvalidDeadline");
    }
  });

  it("ADV-9: Approval request exceeding max_payment_amount is rejected", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-appr-cap").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("adv-offer-cap").digest());
    const overCapAmount = maxPayment.add(new anchor.BN(100_000));
    const apprExpiresAt = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const [pendingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );

    try {
      await program.methods
        .requestApproval(paymentId, overCapAmount, offerHash, apprExpiresAt)
        .accounts({
          agent: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          merchant: merchant.publicKey,
          pendingApproval: pendingPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have rejected requestApproval exceeding payment cap");
    } catch (err: any) {
      expect(err.message).to.include("PaymentCapExceeded");
    }
  });

  it("ADV-10: Approval request with deadline past mandate expiry is rejected", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-appr-deadline").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("adv-offer-deadline").digest());
    const validAmount = new anchor.BN(500_000);
    const pastMandateExpiresAt = expiresAt.add(new anchor.BN(1000));

    const [pendingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );

    try {
      await program.methods
        .requestApproval(paymentId, validAmount, offerHash, pastMandateExpiresAt)
        .accounts({
          agent: agent.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          merchant: merchant.publicKey,
          pendingApproval: pendingPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have rejected approval request expiring past mandate");
    } catch (err: any) {
      expect(err.message).to.include("InvalidDeadline");
    }
  });

  it("ADV-11: Escrow deadline extending past mandate expiry is rejected", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-escrow-past-mandate").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("adv-escrow-offer-past").digest());
    const amount = new anchor.BN(200_000);
    const pastMandateDeadline = expiresAt.add(new anchor.BN(1000));

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );

    try {
      await program.methods
        .requestPayment(paymentId, amount, offerHash, pastMandateDeadline)
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
      expect.fail("Should have rejected requestPayment with deadline past mandate expiry");
    } catch (err: any) {
      expect(err.message).to.include("InvalidDeadline");
    }
  });

  it("ADV-12: Competing pending approvals fail deterministically when available budget is exhausted", async () => {
    // Deposit into vault to ensure sufficient unallocated funds for dedicated mandate
    await program.methods
      .deposit(new anchor.BN(2_000_000))
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

    // Dedicated mandate with exactly 1_000_000 budget and 700_000 max payment
    const dedicatedTaskId = Array.from(crypto.createHash("sha256").update("adv-12-compete-task").digest());
    const [dedicatedMandatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mandate"), vaultPda.toBuffer(), Buffer.from(dedicatedTaskId)],
      program.programId
    );

    const dedicatedBudget = new anchor.BN(1_000_000);
    const dedicatedMaxPayment = new anchor.BN(700_000);
    const dedicatedExpiresAt = new anchor.BN(Math.floor(Date.now() / 1000) + 7200);

    await program.methods
      .createMandate(
        dedicatedTaskId,
        dedicatedBudget,
        dedicatedMaxPayment,
        5,
        new anchor.BN(0),
        dedicatedExpiresAt,
        [merchant.publicKey]
      )
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        tokenVault: tokenVaultPda,
        mandate: dedicatedMandatePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const paymentId1 = Array.from(crypto.createHash("sha256").update("adv-compete-1").digest());
    const paymentId2 = Array.from(crypto.createHash("sha256").update("adv-compete-2").digest());
    const offerHash1 = Array.from(crypto.createHash("sha256").update("adv-offer-compete-1").digest());
    const offerHash2 = Array.from(crypto.createHash("sha256").update("adv-offer-compete-2").digest());
    const reqExpiresAt = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const amountToTest = new anchor.BN(600_000); // 600_000 each: both fit within 1_000_000 individually, but not together

    const [pendingPda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending"), dedicatedMandatePda.toBuffer(), Buffer.from(paymentId1)],
      program.programId
    );
    const [pendingPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending"), dedicatedMandatePda.toBuffer(), Buffer.from(paymentId2)],
      program.programId
    );
    const [escrowPda1] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), dedicatedMandatePda.toBuffer(), Buffer.from(paymentId1)],
      program.programId
    );
    const [escrowPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), dedicatedMandatePda.toBuffer(), Buffer.from(paymentId2)],
      program.programId
    );

    // Agent submits both approval requests
    await program.methods
      .requestApproval(paymentId1, amountToTest, offerHash1, reqExpiresAt)
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        mandate: dedicatedMandatePda,
        merchant: merchant.publicKey,
        pendingApproval: pendingPda1,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    await program.methods
      .requestApproval(paymentId2, amountToTest, offerHash2, reqExpiresAt)
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        mandate: dedicatedMandatePda,
        merchant: merchant.publicKey,
        pendingApproval: pendingPda2,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    // Owner approves request 1 -> takes 600_000 of 1_000_000 budget (remaining = 400_000)
    const approvalDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 1800);
    await program.methods
      .approveRequest(approvalDeadline)
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mandate: dedicatedMandatePda,
        pendingApproval: pendingPda1,
        escrow: escrowPda1,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // Owner attempts to approve request 2 -> MUST fail with BudgetExceeded
    try {
      await program.methods
        .approveRequest(approvalDeadline)
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          mandate: dedicatedMandatePda,
          pendingApproval: pendingPda2,
          escrow: escrowPda2,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      expect.fail("Should have rejected approval when budget is exhausted");
    } catch (err: any) {
      expect(err.message).to.include("BudgetExceeded");
    }

    // Cleanup: reject request 2 so account is closed
    await program.methods
      .rejectRequest()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mandate: dedicatedMandatePda,
        pendingApproval: pendingPda2,
      })
      .signers([owner])
      .rpc();

    // Merchant refunds escrow 1
    await program.methods
      .refundPayment()
      .accounts({
        authority: merchant.publicKey,
        vault: vaultPda,
        mandate: dedicatedMandatePda,
        escrow: escrowPda1,
        tokenVault: tokenVaultPda,
      })
      .signers([merchant])
      .rpc();
  });

  async function advanceValidatorClock(seconds: number) {
    const iters = Math.ceil((seconds * 1000) / 200);
    for (let i = 0; i < iters; i++) {
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: owner.publicKey,
          lamports: 0,
        })
      );
      await provider.sendAndConfirm(tx, [owner]);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  it("ADV-13: Pending approval cannot be approved after expiry", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-appr-expired").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("adv-offer-expired").digest());
    const amount = new anchor.BN(100_000);

    const slot = await provider.connection.getSlot();
    const blockTime = (await provider.connection.getBlockTime(slot)) || Math.floor(Date.now() / 1000);
    const expiresAtSec = blockTime + 2; // 2 seconds in future from validator clock

    const [pendingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pending"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );

    await program.methods
      .requestApproval(paymentId, amount, offerHash, new anchor.BN(expiresAtSec))
      .accounts({
        agent: agent.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        merchant: merchant.publicKey,
        pendingApproval: pendingPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    // Advance validator clock past expiresAtSec
    await advanceValidatorClock(3);

    try {
      await program.methods
        .approveRequest(new anchor.BN(Math.floor(Date.now() / 1000) + 3600))
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          mandate: mandatePda,
          pendingApproval: pendingPda,
          escrow: escrowPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      expect.fail("Should have rejected approval of expired pending request");
    } catch (err: any) {
      expect(err.message).to.include("DeadlinePassed");
    }

    // Clean up expired pending request via rejectRequest
    await program.methods
      .rejectRequest()
      .accounts({
        owner: owner.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        pendingApproval: pendingPda,
      })
      .signers([owner])
      .rpc();
  });

  it("ADV-14: Successful timeout claim after actual deadline has elapsed restores mandate reservation", async () => {
    const paymentId = Array.from(crypto.createHash("sha256").update("adv-actual-timeout").digest());
    const offerHash = Array.from(crypto.createHash("sha256").update("adv-offer-timeout-claim").digest());
    const amount = new anchor.BN(250_000);

    const slot = await provider.connection.getSlot();
    const blockTime = (await provider.connection.getBlockTime(slot)) || Math.floor(Date.now() / 1000);
    const shortDeadline = blockTime + 2; // 2 seconds in future

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), mandatePda.toBuffer(), Buffer.from(paymentId)],
      program.programId
    );

    const mandateBefore = await program.account.mandate.fetch(mandatePda);
    const reservedBefore = mandateBefore.reservedAmount.toNumber();

    await program.methods
      .requestPayment(paymentId, amount, offerHash, new anchor.BN(shortDeadline))
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

    const mandateReserved = await program.account.mandate.fetch(mandatePda);
    expect(mandateReserved.reservedAmount.toNumber()).to.equal(reservedBefore + amount.toNumber());

    // Advance validator clock past shortDeadline
    await advanceValidatorClock(3);

    // Agent executes claimAfterTimeout
    await program.methods
      .claimAfterTimeout()
      .accounts({
        authority: agent.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        escrow: escrowPda,
        tokenVault: tokenVaultPda,
      })
      .signers([agent])
      .rpc();

    const escrow = await program.account.escrow.fetch(escrowPda);
    expect(escrow.state).to.deep.equal({ refunded: {} });

    // Mandate reserved amount restored back
    const mandateAfter = await program.account.mandate.fetch(mandatePda);
    expect(mandateAfter.reservedAmount.toNumber()).to.equal(reservedBefore);
  });

  it("ADV-15: Creating mandate with duplicate merchant allowlist keys fails", async () => {
    const dupTaskId = Array.from(crypto.createHash("sha256").update("adv-dup-merchant-task").digest());
    const [dupMandatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mandate"), vaultPda.toBuffer(), Buffer.from(dupTaskId)],
      program.programId
    );

    try {
      await program.methods
        .createMandate(
          dupTaskId,
          new anchor.BN(100_000),
          new anchor.BN(50_000),
          5,
          new anchor.BN(0),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          [merchant.publicKey, merchant.publicKey] // Duplicate!
        )
        .accounts({
          owner: owner.publicKey,
          vault: vaultPda,
          tokenVault: tokenVaultPda,
          mandate: dupMandatePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
      expect.fail("Should have rejected duplicate merchant in allowlist");
    } catch (err: any) {
      expect(err.message).to.include("InvalidParameter");
    }
  });
});
