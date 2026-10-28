import assert from "node:assert/strict";
import test from "node:test";
import { generateKey, hashKey } from "../src/keys";

// FIPS 180-2, appendix B.1: SHA-256("abc")
test("hashKey matches the SHA-256 reference value", () => {
  assert.equal(hashKey("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("generateKey: 43 base64url characters, never twice the same", () => {
  const a = generateKey();
  const b = generateKey();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});
