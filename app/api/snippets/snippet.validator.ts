import { z } from "zod";

export const createSnippetSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().min(1, "Description is required"),
  code: z.string().min(1, "Code is required"),
  language: z.string().min(1, "Language is required"),
  tags: z.array(z.string()).min(1, "At least one tag is required"),
  ownerWalletAddress: z.string().min(1, "Owner wallet address is required"),
  licenseType: z.string().optional(),
  ownershipProof: z.object({
    snippetId: z.string().uuid(),
    hash: z.string().length(64),
    ownerWallet: z.string().min(1),
    signature: z.string().min(1),
    createdAt: z.string().datetime(),
  }).optional(),
});

export const updateSnippetSchema = z.object({
  title: z.string().min(1, "Title is required").optional(),
  description: z.string().min(1, "Description is required").optional(),
  code: z.string().min(1, "Code is required").optional(),
  language: z.string().min(1, "Language is required").optional(),
  tags: z.array(z.string()).min(1, "At least one tag is required").optional(),
  licenseType: z.string().optional(),
});

export type CreateSnippetDTO = z.infer<typeof createSnippetSchema>;
export type UpdateSnippetDTO = z.infer<typeof updateSnippetSchema>;
