import { AnchorProvider, Program } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, Signer, SystemProgram, TransactionSignature } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import idl from "./idl/solmandate.json";
import {
  findEscrowPda,
  findMandatePda,
  findPendingApprovalPda,
  findTokenVaultPda,
  findVaultPda,
  to32ByteArray,
} from "./pda";
import {
  ApproveRequestParams,
  ClaimAfterTimeoutParams,
  CommitDeliveryParams,
  CreateMandateParams,
  CreateVaultParams,
  DepositParams,
  EscrowAccountData,
  MandateAccountData,
  PayExactParams,
  RefundPaymentParams,
  RejectRequestParams,
  ReleasePaymentParams,
  RequestApprovalParams,
  RequestPaymentParams,
  VaultAccountData,
} from "./types";

export interface SolMandateClientOptions {
  connection: Connection;
  signer: Signer;
  programId?: PublicKey;
}

export class SolMandateClient {
  public readonly connection: Connection;
  public readonly signer: Signer;
  public readonly programId: PublicKey;
  public readonly program: Program;
  public readonly provider: AnchorProvider;

  constructor(options: SolMandateClientOptions) {
    this.connection = options.connection;
    this.signer = options.signer;
    this.programId = options.programId || new PublicKey(idl.address);

    const wallet = {
      publicKey: this.signer.publicKey,
      signTransaction: async (tx: any) => {
        if ("partialSign" in tx) {
          tx.partialSign(this.signer);
        }
        return tx;
      },
      signAllTransactions: async (txs: any[]) => {
        for (const tx of txs) {
          if ("partialSign" in tx) {
            tx.partialSign(this.signer);
          }
        }
        return txs;
      },
      payer: this.signer as any,
    };

    this.provider = new AnchorProvider(this.connection, wallet as any, {
      commitment: "confirmed",
    });
    this.program = new Program(idl as any, this.provider);
  }

  // --- PDAs ---
  public getVaultPda(owner?: PublicKey): [PublicKey, number] {
    return findVaultPda(owner || this.signer.publicKey, this.programId);
  }

  public getTokenVaultPda(vaultPda: PublicKey): [PublicKey, number] {
    return findTokenVaultPda(vaultPda, this.programId);
  }

  public getMandatePda(vaultPda: PublicKey, taskId: Uint8Array | number[] | string): [PublicKey, number] {
    return findMandatePda(vaultPda, taskId, this.programId);
  }

  public getEscrowPda(mandatePda: PublicKey, paymentId: Uint8Array | number[] | string): [PublicKey, number] {
    return findEscrowPda(mandatePda, paymentId, this.programId);
  }

  public getPendingApprovalPda(mandatePda: PublicKey, paymentId: Uint8Array | number[] | string): [PublicKey, number] {
    return findPendingApprovalPda(mandatePda, paymentId, this.programId);
  }

  // --- Vault Instructions ---
  public async createVault(params: CreateVaultParams): Promise<{ signature: TransactionSignature; vaultPda: PublicKey }> {
    const [vaultPda] = this.getVaultPda();
    const [tokenVaultPda] = this.getTokenVaultPda(vaultPda);

    const signature = await this.program.methods
      .createVault()
      .accounts({
        owner: this.signer.publicKey,
        agent: params.agent,
        tokenMint: params.tokenMint,
        vault: vaultPda,
        tokenVault: tokenVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.signer])
      .rpc();

    return { signature, vaultPda };
  }

  public async deposit(params: DepositParams): Promise<TransactionSignature> {
    const [vaultPda] = this.getVaultPda();
    const vault = await this.fetchVault(vaultPda);
    const [tokenVaultPda] = this.getTokenVaultPda(vaultPda);

    const amountBn = new BN(params.amount.toString());

    return await this.program.methods
      .deposit(amountBn)
      .accounts({
        funder: this.signer.publicKey,
        vault: vaultPda,
        tokenMint: vault.tokenMint,
        tokenVault: tokenVaultPda,
        funderTokenAccount: params.funderTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.signer])
      .rpc();
  }

  public async pauseVault(): Promise<TransactionSignature> {
    const [vaultPda] = this.getVaultPda();
    return await this.program.methods
      .pauseVault()
      .accounts({
        owner: this.signer.publicKey,
        vault: vaultPda,
      })
      .signers([this.signer])
      .rpc();
  }

  public async unpauseVault(): Promise<TransactionSignature> {
    const [vaultPda] = this.getVaultPda();
    return await this.program.methods
      .unpauseVault()
      .accounts({
        owner: this.signer.publicKey,
        vault: vaultPda,
      })
      .signers([this.signer])
      .rpc();
  }

  // --- Mandate Instructions ---
  public async createMandate(params: CreateMandateParams): Promise<{ signature: TransactionSignature; mandatePda: PublicKey }> {
    const [vaultPda] = this.getVaultPda();
    const [mandatePda] = this.getMandatePda(vaultPda, params.taskId);

    const taskIdBytes = Array.from(to32ByteArray(params.taskId));
    const totalBudgetBn = new BN(params.totalBudget.toString());
    const maxPaymentBn = new BN(params.maxPaymentAmount.toString());
    const approvalThresholdBn = new BN(params.approvalThreshold.toString());
    const expiresAtBn = new BN(params.expiresAt.toString());

    const signature = await this.program.methods
      .createMandate(
        taskIdBytes,
        totalBudgetBn,
        maxPaymentBn,
        params.maxPurchases,
        approvalThresholdBn,
        expiresAtBn,
        params.merchantAllowlist || []
      )
      .accounts({
        owner: this.signer.publicKey,
        vault: vaultPda,
        mandate: mandatePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.signer])
      .rpc();

    return { signature, mandatePda };
  }

  // --- Mode 1: Pay Exact ---
  public async payExact(params: PayExactParams): Promise<TransactionSignature> {
    const mandate = await this.fetchMandate(params.mandatePda);
    const vault = await this.fetchVault(mandate.vault);
    const [tokenVaultPda] = this.getTokenVaultPda(mandate.vault);

    const amountBn = new BN(params.amount.toString());

    return await this.program.methods
      .payExact(amountBn)
      .accounts({
        agent: this.signer.publicKey,
        vault: mandate.vault,
        mandate: params.mandatePda,
        tokenMint: vault.tokenMint,
        tokenVault: tokenVaultPda,
        merchant: params.merchant,
        merchantTokenAccount: params.merchantTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.signer])
      .rpc();
  }

  // --- Mode 2: Escrow Flow ---
  public async requestPayment(params: RequestPaymentParams): Promise<{ signature: TransactionSignature; escrowPda: PublicKey }> {
    const mandate = await this.fetchMandate(params.mandatePda);
    const [escrowPda] = this.getEscrowPda(params.mandatePda, params.paymentId);

    const paymentIdBytes = Array.from(to32ByteArray(params.paymentId));
    const offerHashBytes = Array.from(to32ByteArray(params.offerHash));
    const amountBn = new BN(params.amount.toString());
    const deadlineBn = new BN(params.deadline.toString());

    const signature = await this.program.methods
      .requestPayment(paymentIdBytes, amountBn, offerHashBytes, deadlineBn)
      .accounts({
        agent: this.signer.publicKey,
        vault: mandate.vault,
        mandate: params.mandatePda,
        merchant: params.merchant,
        escrow: escrowPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.signer])
      .rpc();

    return { signature, escrowPda };
  }

  public async requestApproval(params: RequestApprovalParams): Promise<{ signature: TransactionSignature; pendingApprovalPda: PublicKey }> {
    const mandate = await this.fetchMandate(params.mandatePda);
    const [pendingApprovalPda] = this.getPendingApprovalPda(params.mandatePda, params.paymentId);

    const paymentIdBytes = Array.from(to32ByteArray(params.paymentId));
    const offerHashBytes = Array.from(to32ByteArray(params.offerHash));
    const amountBn = new BN(params.amount.toString());
    const expiresAtBn = new BN(params.expiresAt.toString());

    const signature = await this.program.methods
      .requestApproval(paymentIdBytes, amountBn, offerHashBytes, expiresAtBn)
      .accounts({
        agent: this.signer.publicKey,
        vault: mandate.vault,
        mandate: params.mandatePda,
        merchant: params.merchant,
        pendingApproval: pendingApprovalPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.signer])
      .rpc();

    return { signature, pendingApprovalPda };
  }

  public async approveRequest(params: ApproveRequestParams): Promise<{ signature: TransactionSignature; escrowPda: PublicKey }> {
    const mandate = await this.fetchMandate(params.mandatePda);
    const [escrowPda] = this.getEscrowPda(params.mandatePda, params.paymentId);
    const [pendingApprovalPda] = this.getPendingApprovalPda(params.mandatePda, params.paymentId);

    const deadlineBn = new BN(params.deadline.toString());

    const signature = await this.program.methods
      .approveRequest(deadlineBn)
      .accounts({
        owner: this.signer.publicKey,
        vault: mandate.vault,
        mandate: params.mandatePda,
        pendingApproval: pendingApprovalPda,
        escrow: escrowPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.signer])
      .rpc();

    return { signature, escrowPda };
  }

  public async rejectRequest(params: RejectRequestParams): Promise<TransactionSignature> {
    const mandate = await this.fetchMandate(params.mandatePda);
    const [pendingApprovalPda] = this.getPendingApprovalPda(params.mandatePda, params.paymentId);

    return await this.program.methods
      .rejectRequest()
      .accounts({
        owner: this.signer.publicKey,
        vault: mandate.vault,
        mandate: params.mandatePda,
        pendingApproval: pendingApprovalPda,
      })
      .signers([this.signer])
      .rpc();
  }

  public async commitDelivery(params: CommitDeliveryParams): Promise<TransactionSignature> {
    const deliveryHashBytes = Array.from(to32ByteArray(params.deliveryHash));

    return await this.program.methods
      .commitDelivery(deliveryHashBytes)
      .accounts({
        merchant: this.signer.publicKey,
        escrow: params.escrowPda,
      })
      .signers([this.signer])
      .rpc();
  }

  public async releasePayment(params: ReleasePaymentParams): Promise<TransactionSignature> {
    const mandate = await this.fetchMandate(params.mandatePda);
    const vault = await this.fetchVault(mandate.vault);
    const [tokenVaultPda] = this.getTokenVaultPda(mandate.vault);

    const deliveredHashBytes = params.deliveredHash
      ? Array.from(to32ByteArray(params.deliveredHash))
      : new Array(32).fill(0);

    return await this.program.methods
      .releasePayment(deliveredHashBytes)
      .accounts({
        authority: this.signer.publicKey,
        vault: mandate.vault,
        mandate: params.mandatePda,
        escrow: params.escrowPda,
        tokenMint: vault.tokenMint,
        tokenVault: tokenVaultPda,
        merchant: params.merchant,
        merchantTokenAccount: params.merchantTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.signer])
      .rpc();
  }

  public async refundPayment(params: RefundPaymentParams): Promise<TransactionSignature> {
    const mandate = await this.fetchMandate(params.mandatePda);
    const [tokenVaultPda] = this.getTokenVaultPda(mandate.vault);

    return await this.program.methods
      .refundPayment()
      .accounts({
        authority: this.signer.publicKey,
        vault: mandate.vault,
        mandate: params.mandatePda,
        escrow: params.escrowPda,
        tokenVault: tokenVaultPda,
      })
      .signers([this.signer])
      .rpc();
  }

  public async claimAfterTimeout(params: ClaimAfterTimeoutParams): Promise<TransactionSignature> {
    const mandate = await this.fetchMandate(params.mandatePda);
    const [tokenVaultPda] = this.getTokenVaultPda(mandate.vault);

    return await this.program.methods
      .claimAfterTimeout()
      .accounts({
        authority: this.signer.publicKey,
        vault: mandate.vault,
        mandate: params.mandatePda,
        escrow: params.escrowPda,
        tokenVault: tokenVaultPda,
      })
      .signers([this.signer])
      .rpc();
  }

  // --- Fetch On-Chain State ---
  public async fetchVault(vaultPda: PublicKey): Promise<VaultAccountData> {
    return (await (this.program.account as any).vault.fetch(vaultPda)) as unknown as VaultAccountData;
  }

  public async fetchMandate(mandatePda: PublicKey): Promise<MandateAccountData> {
    return (await (this.program.account as any).mandate.fetch(mandatePda)) as unknown as MandateAccountData;
  }

  public async fetchEscrow(escrowPda: PublicKey): Promise<EscrowAccountData> {
    return (await (this.program.account as any).escrow.fetch(escrowPda)) as unknown as EscrowAccountData;
  }

  public async fetchPendingApproval(pendingApprovalPda: PublicKey): Promise<any> {
    return await (this.program.account as any).pendingApproval.fetch(pendingApprovalPda);
  }
}
