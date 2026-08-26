/**
 * Test environment polyfills.
 *
 * Newer jest-environment-jsdom versions do not expose Node's TextEncoder /
 * TextDecoder globals, which some server libraries (e.g.
 * @neondatabase/serverless) require at import time. These polyfills keep the
 * test environment compatible with those libraries.
 */
const { TextDecoder, TextEncoder } = require("util");

if (typeof globalThis.TextDecoder === "undefined") {
  Object.defineProperty(globalThis, "TextDecoder", {
    value: TextDecoder,
    writable: true,
    configurable: true,
  });
}

if (typeof globalThis.TextEncoder === "undefined") {
  Object.defineProperty(globalThis, "TextEncoder", {
    value: TextEncoder,
    writable: true,
    configurable: true,
  });
}
