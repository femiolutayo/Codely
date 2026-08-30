import { SnippetService } from "@/app/api/snippets/snippet.service";
import { SnippetRepository } from "@/app/api/snippets/snippet.repository";

describe("Snippet Duplicate & Fork Feature (Issue #151)", () => {
  let repository: jest.Mocked<SnippetRepository>;
  let service: SnippetService;

  beforeEach(() => {
    repository = {
      findAll: jest.fn(),
      search: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      softDelete: jest.fn(),
      restore: jest.fn(),
      permanentlyDelete: jest.fn(),
      findForksBySnippetId: jest.fn(),
      findOriginSnippet: jest.fn(),
    } as unknown as jest.Mocked<SnippetRepository>;

    service = new SnippetService(repository);
  });

  describe("Requirement 1 & 3: Snippet Duplication & Metadata Preservation", () => {
    it("creates an identical copy in the user's collection preserving title, tags, language, code, and description", async () => {
      const originalSnippet = {
        id: "orig-uuid-111",
        title: "Stellar Payment Processor",
        description: "Handles cross-border asset transfers",
        code: "export async function sendPayment() { /* stellar tx */ }",
        language: "typescript",
        tags: ["stellar", "payments", "blockchain"],
        owner_wallet_address: "GBORIGINALOWNERWALLET1234567890",
        ipfs_cid: "QmOriginalCID123",
        created_at: "2026-08-20T10:00:00.000Z",
        updated_at: "2026-08-20T10:00:00.000Z",
      };

      const duplicatedSnippet = {
        id: "new-uuid-222",
        title: "Stellar Payment Processor (Copy)",
        description: originalSnippet.description,
        code: originalSnippet.code,
        language: originalSnippet.language,
        tags: originalSnippet.tags,
        owner_wallet_address: "GBNEWUSERWALLET9876543210",
        forked_from_id: originalSnippet.id,
        is_fork: false,
        ipfs_cid: "QmOriginalCID123",
        created_at: "2026-08-25T12:00:00.000Z",
        updated_at: "2026-08-25T12:00:00.000Z",
      };

      repository.findById.mockResolvedValue(originalSnippet);
      repository.create.mockResolvedValue(duplicatedSnippet);

      const targetWallet = "GBNEWUSERWALLET9876543210";
      const result = await service.duplicateSnippet("orig-uuid-111", targetWallet);

      // Verify new snippet is returned with separate ID
      expect(result.id).toBe("new-uuid-222");
      expect(result.id).not.toBe(originalSnippet.id);

      // Verify metadata is strictly preserved
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Stellar Payment Processor (Copy)",
          description: "Handles cross-border asset transfers",
          code: "export async function sendPayment() { /* stellar tx */ }",
          language: "typescript",
          tags: ["stellar", "payments", "blockchain"],
          ownerWalletAddress: targetWallet,
          forkedFromId: "orig-uuid-111",
          isFork: false,
        }),
      );
    });

    it("allows custom title override on duplicate if provided", async () => {
      const original = {
        id: "orig-1",
        title: "Sorting Algorithms",
        description: "QuickSort and MergeSort",
        code: "function quicksort() {}",
        language: "javascript",
        tags: ["algorithms"],
        owner_wallet_address: "GB_USER",
      };

      repository.findById.mockResolvedValue(original);
      repository.create.mockImplementation(async (data: any) => ({
        id: "new-dup-id",
        ...data,
      }));

      const result = await service.duplicateSnippet("orig-1", "GB_USER", "Custom Duplicate Name");

      expect(result.title).toBe("Custom Duplicate Name");
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Custom Duplicate Name",
          forkedFromId: "orig-1",
        }),
      );
    });
  });

  describe("Requirement 2 & 4: Snippet Forking & Derivation Indicator", () => {
    it("creates a new snippet derived from existing with editable content and sets derivation link", async () => {
      const originalSnippet = {
        id: "orig-root-001",
        title: "Base Auth Middleware",
        description: "Basic JWT check",
        code: "function auth(req) { checkJwt(req); }",
        language: "typescript",
        tags: ["auth", "security"],
        owner_wallet_address: "GBAUTHCREATOR",
      };

      const forkOverrides = {
        title: "Stellar Signature Auth Middleware",
        description: "Upgraded auth with Stellar SEP-10 signature check",
        code: "function auth(req) { checkStellarSignature(req); }",
        language: "typescript",
        tags: ["auth", "security", "stellar", "sep10"],
      };

      const expectedForkResult = {
        id: "fork-uuid-999",
        ...forkOverrides,
        owner_wallet_address: "GBNEWDEVWALLET",
        forked_from_id: "orig-root-001",
        is_fork: true,
      };

      repository.findById.mockResolvedValue(originalSnippet);
      repository.create.mockResolvedValue(expectedForkResult);

      const result = await service.forkSnippet("orig-root-001", "GBNEWDEVWALLET", forkOverrides);

      expect(result.id).toBe("fork-uuid-999");
      expect(result.is_fork).toBe(true);
      expect(result.forked_from_id).toBe("orig-root-001");

      // Verify editable modifications applied while linking to parent
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Stellar Signature Auth Middleware",
          description: "Upgraded auth with Stellar SEP-10 signature check",
          code: "function auth(req) { checkStellarSignature(req); }",
          language: "typescript",
          tags: ["auth", "security", "stellar", "sep10"],
          ownerWalletAddress: "GBNEWDEVWALLET",
          forkedFromId: "orig-root-001",
          isFork: true,
        }),
      );
    });

    it("defaults to 'Fork of [Title]' when no title override is specified in fork payload", async () => {
      const original = {
        id: "orig-2",
        title: "Horizon Event Streamer",
        description: "Streams ledger events",
        code: "streamEvents()",
        language: "typescript",
        tags: ["horizon"],
        owner_wallet_address: "GB_ORIG",
      };

      repository.findById.mockResolvedValue(original);
      repository.create.mockImplementation(async (data: any) => ({
        id: "fork-id-2",
        ...data,
      }));

      const result = await service.forkSnippet("orig-2", "GB_DEV", { code: "streamEventsV2()" });

      expect(result.title).toBe("Fork of Horizon Event Streamer");
      expect(result.forkedFromId).toBe("orig-2");
      expect(result.isFork).toBe(true);
    });
  });

  describe("Requirement 6: History Tracking & Traceability", () => {
    it("fetches all forks derived from a snippet", async () => {
      const mockForks = [
        { id: "fork-1", title: "Fork A", forked_from_id: "root-1", is_fork: true },
        { id: "fork-2", title: "Fork B", forked_from_id: "root-1", is_fork: true },
      ];

      repository.findForksBySnippetId.mockResolvedValue(mockForks);

      const forks = await service.getSnippetForks("root-1");
      expect(forks).toEqual(mockForks);
      expect(repository.findForksBySnippetId).toHaveBeenCalledWith("root-1");
    });

    it("fetches origin snippet for a forked snippet", async () => {
      const originalSnippet = {
        id: "root-1",
        title: "Root Template",
        language: "python",
      };

      repository.findOriginSnippet.mockResolvedValue(originalSnippet);

      const origin = await service.getSnippetOrigin("fork-1");
      expect(origin).toEqual(originalSnippet);
      expect(repository.findOriginSnippet).toHaveBeenCalledWith("fork-1");
    });
  });

  describe("Error Handling & Guardrails", () => {
    it("throws clear error when duplicating a non-existent snippet", async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.duplicateSnippet("missing-id", "GB_USER")).rejects.toThrow("Snippet not found");
    });

    it("throws clear error when forking a non-existent snippet", async () => {
      repository.findById.mockResolvedValue(null);
      await expect(service.forkSnippet("missing-id", "GB_USER")).rejects.toThrow("Snippet not found");
    });
  });
});
