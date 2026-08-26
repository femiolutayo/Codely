import { classifyStellarError } from "@/lib/stellar";

describe("classifyStellarError", () => {
  it("classifies network timeout as retryable", () => {
    expect(classifyStellarError("TimeoutError: request timed out")).toEqual({
      retryable: true,
      reason: "network_timeout",
    });
  });

  it("classifies connection reset as retryable", () => {
    expect(classifyStellarError("read ECONNRESET")).toEqual({
      retryable: true,
      reason: "network_timeout",
    });
  });

  it("classifies rate limit as retryable", () => {
    expect(classifyStellarError("429 Too Many Requests")).toEqual({
      retryable: true,
      reason: "rate_limited",
    });
  });

  it("classifies Horizon 500 as retryable", () => {
    expect(classifyStellarError("Horizon 500 Internal Server Error")).toEqual({
      retryable: true,
      reason: "horizon_server_error",
    });
  });

  it("classifies tx_bad_seq as retryable", () => {
    expect(classifyStellarError("tx_bad_seq")).toEqual({
      retryable: true,
      reason: "tx_bad_seq",
    });
  });

  it("classifies tx_too_late as retryable", () => {
    expect(classifyStellarError("tx_too_late")).toEqual({
      retryable: true,
      reason: "tx_too_late",
    });
  });

  it("classifies tx_already_exists as permanent", () => {
    expect(classifyStellarError("tx_already_exists")).toEqual({
      retryable: false,
      reason: "tx_already_exists",
    });
  });

  it("classifies tx_failed as permanent", () => {
    expect(classifyStellarError("tx_failed")).toEqual({
      retryable: false,
      reason: "tx_failed",
    });
  });

  it("classifies tx_bad_auth as permanent", () => {
    expect(classifyStellarError("tx_bad_auth")).toEqual({
      retryable: false,
      reason: "tx_bad_auth",
    });
  });

  it("classifies unknown errors as permanent", () => {
    expect(classifyStellarError("Something weird happened")).toEqual({
      retryable: false,
      reason: "unknown_error",
    });
  });

  it("is case-insensitive", () => {
    expect(classifyStellarError("TX_BAD_SEQ")).toEqual({
      retryable: true,
      reason: "tx_bad_seq",
    });
  });
});
