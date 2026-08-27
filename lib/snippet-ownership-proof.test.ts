import * as StellarSdk from "stellar-sdk";
import {
  canonicalizeProofPayload,
  hashSnippetContent,
  signSnippetOwnershipProof,
  verifySnippetOwnershipProof,
} from "./snippet-ownership-proof";

describe("snippet ownership proofs", () => {
  const keypair = StellarSdk.Keypair.random();
  const payload = {
    snippetId: "9d2d8f45-0e6b-4aa2-8bf6-0f1a4d9c7c77",
    hash: hashSnippetContent("const answer = 42;"),
    ownerWallet: keypair.publicKey(),
    createdAt: "2026-08-27T12:00:00.000Z",
  };

  it("verifies a proof signed by the owner", () => {
    const proof = signSnippetOwnershipProof(keypair.secret(), payload);
    expect(verifySnippetOwnershipProof(proof)).toEqual({ valid: true });
  });

  it("rejects a tampered payload", () => {
    const proof = signSnippetOwnershipProof(keypair.secret(), payload);
    expect(verifySnippetOwnershipProof({ ...proof, hash: "0".repeat(64) }).valid).toBe(false);
  });

  it("rejects a signature from another wallet", () => {
    const proof = signSnippetOwnershipProof(keypair.secret(), payload);
    const otherWallet = StellarSdk.Keypair.random().publicKey();
    expect(verifySnippetOwnershipProof({ ...proof, ownerWallet: otherWallet }).valid).toBe(false);
  });

  it("uses stable canonical ordering for replay detection", () => {
    expect(canonicalizeProofPayload(payload)).toBe(
      '{"createdAt":"2026-08-27T12:00:00.000Z","hash":"' +
        payload.hash +
        '","ownerWallet":"' +
        payload.ownerWallet +
        '","snippetId":"9d2d8f45-0e6b-4aa2-8bf6-0f1a4d9c7c77"}',
    );
  });
});