import { SnippetService } from "../app/api/snippets/snippet.service";
import { SnippetRepository } from "../app/api/snippets/snippet.repository";
import { IPFSService } from "../lib/ipfs.service";

jest.mock("../lib/ipfs.service", () => ({
  IPFSService: {
    uploadToIPFS: jest.fn().mockResolvedValue("QmTestCID"),
  },
}));

// Mock the repository
const mockRepository = {
  findAll: jest.fn(),
  search: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  softDelete: jest.fn(),
  restore: jest.fn(),
  permanentlyDelete: jest.fn(),
} as unknown as SnippetRepository;

// Suppress console.error in tests
let consoleSpy: jest.SpyInstance;
beforeAll(() => {
  consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
  consoleSpy.mockRestore();
});

describe("SnippetService", () => {
  let service: SnippetService;

  beforeEach(() => {
    service = new SnippetService(mockRepository);
    jest.clearAllMocks();
  });

  describe("getAllSnippets", () => {
    it("should return all snippets", async () => {
      const mockSnippets = [{ id: "1", title: "Test Snippet" }];
      (mockRepository.findAll as jest.Mock).mockResolvedValue(mockSnippets);

      const result = await service.getAllSnippets();
      expect(result).toEqual(mockSnippets);
      expect(mockRepository.findAll).toHaveBeenCalledTimes(1);
    });

    it("should throw error when fetch fails", async () => {
      (mockRepository.findAll as jest.Mock).mockRejectedValue(
        new Error("DB error"),
      );

      await expect(service.getAllSnippets()).rejects.toThrow(
        "Failed to fetch snippets",
      );
    });
  });

  describe("searchSnippets", () => {
    it("should return filtered snippets", async () => {
      const filters = {
        title: "React",
        language: "typescript",
        tags: ["frontend"],
        keyword: "hooks",
        limit: 10,
        offset: 0,
      };
      const mockResult = {
        data: [{ id: "1", title: "React Hooks" }],
        total: 1,
        limit: 10,
        offset: 0,
        hasMore: false,
      };

      (mockRepository.search as jest.Mock).mockResolvedValue(mockResult);

      const result = await service.searchSnippets(filters);
      expect(result).toEqual(mockResult);
      expect(mockRepository.search).toHaveBeenCalledWith(filters);
    });

    it("should throw error when search fails", async () => {
      (mockRepository.search as jest.Mock).mockRejectedValue(
        new Error("DB error"),
      );

      await expect(
        service.searchSnippets({ limit: 10, offset: 0, keyword: "react" }),
      ).rejects.toThrow("Failed to search snippets");
    });
  });

  describe("getSnippetById", () => {
    it("should return snippet by id", async () => {
      const mockSnippet = { id: "1", title: "Test Snippet" };
      (mockRepository.findById as jest.Mock).mockResolvedValue(mockSnippet);

      const result = await service.getSnippetById("1");
      expect(result).toEqual(mockSnippet);
      expect(mockRepository.findById).toHaveBeenCalledWith("1");
    });

    it("should throw error when snippet not found", async () => {
      (mockRepository.findById as jest.Mock).mockResolvedValue(null);

      await expect(service.getSnippetById("999")).rejects.toThrow(
        "Snippet not found",
      );
    });
  });

  describe("createSnippet", () => {
    it("should successfully create a snippet with valid data", async () => {
      const validData = {
        title: "Test",
        description: "Desc",
        code: 'console.log("hi")',
        language: "javascript",
        tags: ["test"],
        ownerWalletAddress:
          "G1234567890123456789012345678901234567890123456789012345",
      };

      const expectedResult = { id: "1", ...validData, ipfsCid: "QmTestCID" };
      (mockRepository.create as jest.Mock).mockResolvedValue(expectedResult);

      const result = await service.createSnippet(validData);
      expect(result).toEqual(expectedResult);
      expect(mockRepository.create).toHaveBeenCalledWith({
        ...validData,
        ipfsCid: "QmTestCID",
      });
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining(validData),
      );
    });

    it("should throw error with invalid data", async () => {
      const invalidData = { title: "" };

      await expect(service.createSnippet(invalidData)).rejects.toThrow();
    });
  });

  describe("updateSnippet", () => {
    it("should update snippet with valid data", async () => {
      const updateData = { title: "Updated Title" };
      const existingSnippet = { id: "1", title: "Old Title", code: "code", owner_wallet_address: "G123" };
      const updatedSnippet = { id: "1", title: "Updated Title" };

      (mockRepository.findById as jest.Mock).mockResolvedValue({
        id: "1",
        title: "Old Title",
      });
      (mockRepository.findById as jest.Mock).mockResolvedValue(existingSnippet);
      (mockRepository.update as jest.Mock).mockResolvedValue(updatedSnippet);

      const result = await service.updateSnippet("1", updateData);
      expect(result).toEqual(updatedSnippet);
      expect(mockRepository.update).toHaveBeenCalledWith("1", expect.objectContaining(updateData));
    });

    it("should throw error when snippet not found", async () => {
      const updateData = { title: "Updated Title" };
      (mockRepository.findById as jest.Mock).mockResolvedValue(null);
      (mockRepository.update as jest.Mock).mockResolvedValue(null);

      await expect(service.updateSnippet("999", updateData)).rejects.toThrow(
        "Snippet not found",
      );
    });
  });

  describe("duplicateSnippet", () => {
    it("should duplicate snippet with identical metadata and new ID", async () => {
      const original = {
        id: "orig-123",
        title: "My React Hook",
        description: "Custom hook",
        code: "const useData = () => {}",
        language: "typescript",
        tags: ["react", "hooks"],
        owner_wallet_address: "G_ORIGINAL",
      };
      const duplicated = {
        id: "dup-456",
        title: "My React Hook (Copy)",
        description: "Custom hook",
        code: "const useData = () => {}",
        language: "typescript",
        tags: ["react", "hooks"],
        owner_wallet_address: "G_NEW_USER",
        forked_from_id: "orig-123",
        is_fork: false,
      };

      (mockRepository.findById as jest.Mock).mockResolvedValue(original);
      (mockRepository.create as jest.Mock).mockResolvedValue(duplicated);

      const result = await service.duplicateSnippet("orig-123", "G_NEW_USER");
      expect(result).toEqual(duplicated);
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "My React Hook (Copy)",
          description: original.description,
          code: original.code,
          language: original.language,
          tags: original.tags,
          ownerWalletAddress: "G_NEW_USER",
          forkedFromId: "orig-123",
          isFork: false,
        }),
      );
    });

    it("should throw error if original snippet not found on duplicate", async () => {
      (mockRepository.findById as jest.Mock).mockResolvedValue(null);
      await expect(service.duplicateSnippet("invalid-id", "G_USER")).rejects.toThrow("Snippet not found");
    });
  });

  describe("forkSnippet", () => {
    it("should create forked snippet with derivation link and customizable content", async () => {
      const original = {
        id: "orig-123",
        title: "Original Algorithm",
        description: "Original description",
        code: "function solve() {}",
        language: "javascript",
        tags: ["algorithm"],
        owner_wallet_address: "G_ORIGINAL",
      };

      const forkOverrides = {
        title: "Customized Fork",
        code: "function solveOptimized() {}",
        tags: ["algorithm", "optimized"],
      };

      const forked = {
        id: "fork-789",
        title: "Customized Fork",
        description: "Original description",
        code: "function solveOptimized() {}",
        language: "javascript",
        tags: ["algorithm", "optimized"],
        owner_wallet_address: "G_FORKER",
        forked_from_id: "orig-123",
        is_fork: true,
      };

      (mockRepository.findById as jest.Mock).mockResolvedValue(original);
      (mockRepository.create as jest.Mock).mockResolvedValue(forked);

      const result = await service.forkSnippet("orig-123", "G_FORKER", forkOverrides);
      expect(result).toEqual(forked);
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Customized Fork",
          code: "function solveOptimized() {}",
          language: "javascript",
          tags: ["algorithm", "optimized"],
          ownerWalletAddress: "G_FORKER",
          forkedFromId: "orig-123",
          isFork: true,
        }),
      );
    });

    it("should fallback to 'Fork of [Title]' when no title override is passed", async () => {
      const original = {
        id: "orig-123",
        title: "Original Algorithm",
        description: "Original description",
        code: "function solve() {}",
        language: "javascript",
        tags: ["algorithm"],
        owner_wallet_address: "G_ORIGINAL",
      };

      const forked = {
        id: "fork-789",
        title: "Fork of Original Algorithm",
        description: "Original description",
        code: "function solve() {}",
        language: "javascript",
        tags: ["algorithm"],
        owner_wallet_address: "G_FORKER",
        forked_from_id: "orig-123",
        is_fork: true,
      };

      (mockRepository.findById as jest.Mock).mockResolvedValue(original);
      (mockRepository.create as jest.Mock).mockResolvedValue(forked);

      const result = await service.forkSnippet("orig-123", "G_FORKER", {});
      expect(result.title).toBe("Fork of Original Algorithm");
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Fork of Original Algorithm",
          forkedFromId: "orig-123",
          isFork: true,
        }),
      );
    });
  });

  describe("deleteSnippet", () => {
    it("should delete snippet successfully", async () => {
      const existingSnippet = { id: "1", title: "Test" };
      (mockRepository.softDelete as jest.Mock).mockResolvedValue(existingSnippet);

      await expect(service.deleteSnippet("1")).resolves.not.toThrow();
      expect(mockRepository.softDelete).toHaveBeenCalledWith("1", null);
    });

    it("should throw error when snippet not found", async () => {
      (mockRepository.softDelete as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteSnippet("999")).rejects.toThrow(
        "Snippet not found",
      );
    });
  });
});

