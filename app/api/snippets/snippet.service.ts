import {
  SnippetRepository,
  PaginationOptions,
  PaginatedResult,
  SearchSnippetsOptions,
} from "./snippet.repository";
import { createSnippetSchema, updateSnippetSchema } from "./snippet.validator";
import { appendActivityLog } from "@/lib/activity-logger";
import { submitHashToStellar } from "@/lib/stellar";
import { IPFSService } from "@/lib/ipfs.service";
import {
  hashSnippetContent,
  SnippetOwnershipProof,
  verifySnippetOwnershipProof,
} from "@/lib/snippet-ownership-proof";

export class SnippetService {
  constructor(private snippetRepository: SnippetRepository) {}

  async getAllSnippets(
    options?: PaginationOptions,
  ): Promise<PaginatedResult<any>> {
    try {
      return await this.snippetRepository.findAll(options);
    } catch (error) {
      console.error("[Service] Error fetching snippets:", error);
      throw new Error("Failed to fetch snippets");
    }
  }

  async searchSnippets(
    options: SearchSnippetsOptions,
  ): Promise<PaginatedResult<any>> {
    try {
      return await this.snippetRepository.search(options);
    } catch (error) {
      console.error("[Service] Error searching snippets:", error);
      throw new Error("Failed to search snippets");
    }
  }

  async getSnippetById(id: string) {
    try {
      const snippet = await this.snippetRepository.findById(id);
      if (!snippet) {
        throw new Error("Snippet not found");
      }
      return snippet;
    } catch (error) {
      console.error("[Service] Error fetching snippet:", error);
      throw error instanceof Error
        ? error
        : new Error("Failed to fetch snippet");
    }
  }

  async createSnippet(data: unknown) {
    // 1. Validation (Throws ZodError if invalid)
    const validatedData = createSnippetSchema.parse(data);

    // 2. Database interaction via Repository
    try {
      // Upload code to IPFS
      let ipfsCid;
      try {
        ipfsCid = await IPFSService.uploadToIPFS(validatedData.code);
      } catch (ipfsError) {
        console.error("[Service] IPFS upload failed:", ipfsError);
        // We can either fail the creation or continue without CID. 
        // Requirements say: "system should generate and store IPFS CIDs in the database"
        throw new Error("Failed to upload snippet to IPFS");
      }

      // First create the snippet
      const requestedProof = validatedData.ownershipProof;
      if (requestedProof) {
        const proofCheck = verifySnippetOwnershipProof(requestedProof as SnippetOwnershipProof);
        if (
          !proofCheck.valid ||
          requestedProof.ownerWallet.toUpperCase() !== validatedData.ownerWalletAddress.toUpperCase() ||
          requestedProof.hash !== hashSnippetContent(validatedData.code)
        ) {
          await appendActivityLog("snippet.proof_verification_failed", "snippet", {
            actorWallet: requestedProof.ownerWallet,
            metadata: { error: proofCheck.error || "Proof does not match snippet" },
          });
          throw new Error("Invalid ownership proof");
        }
      }
      let snippet = await this.snippetRepository.create({
        ...validatedData,
        ipfsCid,
        id: requestedProof?.snippetId,
      });

      if (requestedProof) {
        const proof = requestedProof as SnippetOwnershipProof;
        if (proof.snippetId !== snippet.id) {
          throw new Error("Ownership proof does not match snippet");
        }
        const result = verifySnippetOwnershipProof(proof);
        if (
          !result.valid ||
          proof.ownerWallet.toUpperCase() !== String(snippet.owner_wallet_address).toUpperCase() ||
          proof.hash !== hashSnippetContent(snippet.code)
        ) {
          await appendActivityLog("snippet.proof_verification_failed", "snippet", {
            actorWallet: proof.ownerWallet,
            resourceId: snippet.id,
            metadata: { error: result.error || "Proof does not match snippet" },
          });
          throw new Error("Invalid ownership proof");
        }
        const anchor = await submitHashToStellar(
          process.env.STELLAR_SECRET_KEY || "",
          proof.signature,
          proof.snippetId,
          proof.createdAt,
        );
        if (!anchor.success || !anchor.transactionHash) {
          throw new Error(anchor.error || "Failed to anchor ownership proof");
        }
        await this.snippetRepository.saveOwnershipProof(
          proof,
          anchor.transactionHash,
        );
        await appendActivityLog("snippet.proof_generated", "snippet", {
          actorWallet: proof.ownerWallet,
          resourceId: snippet.id,
          metadata: { hash: proof.hash, createdAt: proof.createdAt },
        });
      }

      // If licenseType is provided, mint it and update the snippet
      if (validatedData.licenseType && validatedData.licenseType !== "None") {
        const { mintSnippetLicenseOnStellar } = await import("@/lib/stellar");
        const tx = await mintSnippetLicenseOnStellar({
          snippetId: snippet.id,
          licenseType: validatedData.licenseType,
          ownerWalletAddress: validatedData.ownerWalletAddress,
        });

        if (tx.success && tx.transactionHash) {
          snippet = await this.snippetRepository.update(snippet.id, {
            licenseTransactionHash: tx.transactionHash,
            licenseMetadata: {
              type: validatedData.licenseType,
              timestamp: tx.timestamp,
              memo: tx.memo,
            }
          } as any);
        }
      }
      return snippet;
    } catch (error) {
      console.error("[Service] Error creating snippet:", error);
      if (error instanceof Error && (error.message === "Invalid ownership proof" || error.message.includes("ownership proof"))) {
        throw error;
      }
      throw new Error("Failed to create snippet");
    }
  }

  async getOwnershipProof(id: string) {
    const snippet = await this.getSnippetById(id);
    const proof = await this.snippetRepository.findOwnershipProof(id);
    const verification = proof
      ? verifySnippetOwnershipProof(proof as SnippetOwnershipProof)
      : { valid: false, error: "Ownership proof not found" };
    await appendActivityLog(
      verification.valid ? "snippet.proof_verified" : "snippet.proof_verification_failed",
      "snippet",
      { actorWallet: proof?.ownerWallet || snippet.owner_wallet_address, resourceId: id, metadata: { error: verification.error } },
    );
    return { proof, verified: verification.valid, error: verification.error };
  }

  async updateSnippet(id: string, data: unknown) {
    const validatedData = updateSnippetSchema.parse(data);

    try {
      const existing = await this.snippetRepository.findById(id);
      if (!existing) {
        throw new Error("Snippet not found");
      }

      let ipfsCid;
      if (validatedData.code !== undefined) {
        try {
          ipfsCid = await IPFSService.uploadToIPFS(validatedData.code);
        } catch (ipfsError) {
          console.error("[Service] IPFS upload failed during update:", ipfsError);
          throw new Error("Failed to upload snippet to IPFS");
        }
      }

      let updated = await this.snippetRepository.update(id, {
        ...validatedData,
        ipfsCid
      });

      // Mint license if it's being set for the first time
      if (
        validatedData.licenseType &&
        validatedData.licenseType !== "None" &&
        !existing.license_transaction_hash
      ) {
        const { mintSnippetLicenseOnStellar } = await import("@/lib/stellar");
        const tx = await mintSnippetLicenseOnStellar({
          snippetId: id,
          licenseType: validatedData.licenseType,
          ownerWalletAddress: existing.owner_wallet_address,
        });

        if (tx.success && tx.transactionHash) {
          updated = await this.snippetRepository.update(id, {
            licenseTransactionHash: tx.transactionHash,
            licenseMetadata: {
              type: validatedData.licenseType,
              timestamp: tx.timestamp,
              memo: tx.memo,
            }
          } as any);
        }
      }

      return updated;
    } catch (error) {
      if (error instanceof Error && error.message === "Snippet not found") {
        throw error;
      }
      console.error("[Service] Error updating snippet:", error);
      throw new Error("Failed to update snippet");
    }
  }

  /**
   * Soft delete a snippet (marks as deleted, preserves data)
   */
  async deleteSnippet(id: string, userWalletAddress: string | null = null) {
    try {
      const deleted = await this.snippetRepository.softDelete(id, userWalletAddress);
      if (!deleted) {
        throw new Error("Snippet not found");
      }

      // Log the delete action using appendActivityLog
      await appendActivityLog("snippet.deleted", "snippet", {
        actorWallet: userWalletAddress,
        resourceId: id,
        metadata: {
          title: deleted.title,
          language: deleted.language,
          deletedAt: new Date().toISOString(),
        },
      });

      return deleted;
    } catch (error) {
      if (error instanceof Error && error.message === "Snippet not found") {
        throw error;
      }
      console.error("[Service] Error deleting snippet:", error);
      throw new Error("Failed to delete snippet");
    }
  }

  /**
   * Restore a soft-deleted snippet
   */
  async restoreSnippet(id: string, userWalletAddress: string | null = null) {
    try {
      const restored = await this.snippetRepository.restore(id);
      if (!restored) {
        throw new Error("Snippet not found or not deleted");
      }

      // Log the restore action using appendActivityLog
      await appendActivityLog("snippet.restored", "snippet", {
        actorWallet: userWalletAddress,
        resourceId: id,
        metadata: {
          title: restored.title,
          language: restored.language,
          restoredAt: new Date().toISOString(),
        },
      });

      return restored;
    } catch (error) {
      console.error("[Service] Error restoring snippet:", error);
      throw error instanceof Error
        ? error
        : new Error("Failed to restore snippet");
    }
  }

  /**
   * Get trash (deleted snippets) for a user
   */
  async getUserTrash(
    userWalletAddress: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<any>> {
    try {
      return await this.snippetRepository.findDeletedByUser(
        userWalletAddress,
        options,
      );
    } catch (error) {
      console.error("[Service] Error fetching trash:", error);
      throw new Error("Failed to fetch trash");
    }
  }

  /**
   * Get all deleted snippets (admin only)
   */
  async getAllDeletedSnippets(
    options?: PaginationOptions,
  ): Promise<PaginatedResult<any>> {
    try {
      return await this.snippetRepository.findAllDeleted(options);
    } catch (error) {
      console.error("[Service] Error fetching deleted snippets:", error);
      throw new Error("Failed to fetch deleted snippets");
    }
  }

  /**
   * Permanently delete a snippet (hard delete - admin only)
   */
  async permanentlyDeleteSnippet(id: string) {
    try {
      const deleted = await this.snippetRepository.permanentlyDelete(id);
      if (!deleted) {
        throw new Error("Snippet not found");
      }

      // Log the permanent delete using appendActivityLog
      await appendActivityLog("snippet.deleted", "snippet", {
        actorWallet: null,
        resourceId: id,
        metadata: {
          title: deleted.title,
          language: deleted.language,
          permanentlyDeleted: true,
          deletedAt: new Date().toISOString(),
        },
      });

      return deleted;
    } catch (error) {
      console.error("[Service] Error permanently deleting snippet:", error);
      throw error instanceof Error
        ? error
        : new Error("Failed to permanently delete snippet");
    }
  }

  /**
   * Fork a snippet: create a new snippet owned by the forker with same code/metadata
   * Generates and anchors ownership proof for the forked snippet
   */
  async forkSnippet(
    originalSnippetId: string,
    forkerWalletAddress: string,
    proof: SnippetOwnershipProof,
  ) {
    try {
      // 1. Get the original snippet
      const original = await this.snippetRepository.findById(originalSnippetId);
      if (!original) {
        throw new Error("Original snippet not found");
      }

      // 2. Validate the fork proof
      const proofCheck = verifySnippetOwnershipProof(proof);
      if (!proofCheck.valid) {
        await appendActivityLog("snippet.fork_proof_verification_failed", "snippet", {
          actorWallet: forkerWalletAddress,
          metadata: { originalSnippetId, error: proofCheck.error || "Invalid fork proof" },
        });
        throw new Error(proofCheck.error || "Invalid fork proof");
      }

      // 3. Verify proof matches forker and content
      if (proof.ownerWallet.toUpperCase() !== forkerWalletAddress.toUpperCase()) {
        await appendActivityLog("snippet.fork_proof_verification_failed", "snippet", {
          actorWallet: forkerWalletAddress,
          metadata: { originalSnippetId, error: "Proof wallet does not match forker" },
        });
        throw new Error("Proof wallet does not match forker");
      }

      const expectedHash = hashSnippetContent(original.code);
      if (proof.hash !== expectedHash) {
        await appendActivityLog("snippet.fork_proof_verification_failed", "snippet", {
          actorWallet: forkerWalletAddress,
          metadata: { originalSnippetId, error: "Proof hash does not match code" },
        });
        throw new Error("Proof hash does not match snippet code");
      }

      // 4. Upload to IPFS
      let ipfsCid;
      try {
        ipfsCid = await IPFSService.uploadToIPFS(original.code);
      } catch (ipfsError) {
        console.error("[Service] IPFS upload failed during fork:", ipfsError);
        throw new Error("Failed to upload forked snippet to IPFS");
      }

      // 5. Create the forked snippet
      const forkedSnippet = await this.snippetRepository.create({
        title: `${original.title} (forked)`,
        description: original.description
          ? `Forked from snippet ${originalSnippetId}: ${original.description}`
          : `Forked from snippet ${originalSnippetId}`,
        code: original.code,
        language: original.language,
        tags: original.tags || [],
        licenseType: original.license_type,
        ownerWalletAddress: forkerWalletAddress,
        ipfsCid,
        id: proof.snippetId, // Use the snippet ID from the proof
      });

      // 6. Anchor the proof to Stellar
      const anchor = await submitHashToStellar(
        process.env.STELLAR_SECRET_KEY || "",
        proof.signature,
        proof.snippetId,
        proof.createdAt,
      );

      if (!anchor.success || !anchor.transactionHash) {
        throw new Error(anchor.error || "Failed to anchor fork proof to Stellar");
      }

      // 7. Save the proof to the database
      await this.snippetRepository.saveOwnershipProof(proof, anchor.transactionHash);

      // 8. Log the fork action
      await appendActivityLog("snippet.forked", "snippet", {
        actorWallet: forkerWalletAddress,
        resourceId: forkedSnippet.id,
        metadata: {
          title: forkedSnippet.title,
          language: forkedSnippet.language,
          originalSnippetId,
          proofHash: proof.hash,
          createdAt: proof.createdAt,
        },
      });

      return forkedSnippet;
    } catch (error) {
      console.error("[Service] Error forking snippet:", error);
      if (
        error instanceof Error &&
        (error.message.includes("proof") || error.message.includes("not found"))
      ) {
        throw error;
      }
      throw new Error("Failed to fork snippet");
    }
  }
}
