import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { constants } from "starknet";
import { MAX_CALLDATA, validateProveBody } from "../src/validate";

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tx.json"), "utf8"));

// A request body made of the reference transaction, changed by `edit`.
function makeBody(blockNumber: unknown = 123, edit: (tx: any) => void = () => {}): unknown {
  const tx = structuredClone(fixture);
  edit(tx);
  return { blockNumber, tx };
}

test("the fixture is valid; blockNumber accepts decimal and hex strings", () => {
  const checked = validateProveBody(makeBody());
  assert.ok(checked.ok);
  assert.equal(checked.blockNumber, 123);
  assert.deepEqual(checked.tx, fixture);

  const blocks: Array<[unknown, number]> = [
    ["0x7b", 123],
    ["12", 12],
    [0, 0],
    ["0x0", 0],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ];
  for (const [given, expected] of blocks) {
    const result = validateProveBody(makeBody(given));
    assert.ok(result.ok, String(given));
    assert.equal(result.blockNumber, expected);
  }
});

test("invalid bodies name the field", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["negative block", makeBody(-1), /blockNumber/],
    ["fractional block", makeBody(1.5), /blockNumber/],
    ["text block", makeBody("abc"), /blockNumber/],
    ["block beyond 2^53", makeBody("0xffffffffffffffff"), /blockNumber/],
    ["missing block", { tx: fixture }, /blockNumber/],
    ["wrong type", makeBody(123, (tx) => (tx.type = "DEPLOY_ACCOUNT")), /tx\.type/],
    ["wrong version", makeBody(123, (tx) => (tx.version = "0x1")), /tx\.version/],
    ["too much calldata", makeBody(123, (tx) => (tx.calldata = Array(MAX_CALLDATA + 1).fill("0x1"))), /tx\.calldata/],
    ["calldata not hex", makeBody(123, (tx) => (tx.calldata = ["xyz"])), /tx\.calldata/],
    ["calldata not an array", makeBody(123, (tx) => (tx.calldata = "0x1")), /tx\.calldata/],
    ["sender address too long", makeBody(123, (tx) => (tx.sender_address = "0x" + "1".repeat(65))), /tx\.sender_address/],
    ["missing nonce", makeBody(123, (tx) => delete tx.nonce), /tx\.nonce/],
    ["tip not a string", makeBody(123, (tx) => (tx.tip = 5)), /tx\.tip/],
    ["signature not hex", makeBody(123, (tx) => (tx.signature = [1])), /tx\.signature/],
    ["missing l2 gas bounds", makeBody(123, (tx) => delete tx.resource_bounds.l2_gas), /tx\.resource_bounds/],
    ["bound not hex", makeBody(123, (tx) => (tx.resource_bounds.l1_gas.max_amount = "12")), /tx\.resource_bounds/],
    ["bad nonce DA mode", makeBody(123, (tx) => (tx.nonce_data_availability_mode = "L3")), /nonce_data_availability_mode/],
    ["bad fee DA mode", makeBody(123, (tx) => (tx.fee_data_availability_mode = 1)), /fee_data_availability_mode/],
    ["no tx", { blockNumber: 1 }, /tx/],
    ["body null", null, /body/],
    ["body an array", [], /body/],
  ];
  for (const [label, input, re] of cases) {
    const result = validateProveBody(input);
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.match(result.message, re, label);
  }
});

test("exactly MAX_CALLDATA elements are accepted", () => {
  const result = validateProveBody(makeBody(123, (tx) => (tx.calldata = Array(MAX_CALLDATA).fill("0x1"))));
  assert.ok(result.ok);
});

test("fields that are not part of an INVOKE v3 transaction are dropped", () => {
  const result = validateProveBody(
    makeBody(123, (tx) => {
      tx.proof_facts = ["0x1"];
      tx.extra = "x";
    }),
  );
  assert.ok(result.ok);
  assert.deepEqual(result.tx, fixture);
});

test("a felt is below the prime of the field, a sender address below the address bound", () => {
  const hexOf = (n: bigint) => "0x" + n.toString(16);
  const withCalldata = (value: string) => makeBody(123, (tx) => (tx.calldata = [value]));

  assert.ok(validateProveBody(withCalldata(hexOf(constants.PRIME - 1n))).ok); // the largest felt
  for (const value of [hexOf(constants.PRIME), "0x" + "f".repeat(64), "0x"]) {
    const result = validateProveBody(withCalldata(value));
    assert.equal(result.ok, false, value);
    if (!result.ok) assert.match(result.message, /tx\.calldata/);
  }

  // PRIME - 1 is a felt but not an address
  const address = validateProveBody(makeBody(123, (tx) => (tx.sender_address = hexOf(constants.PRIME - 1n))));
  assert.equal(address.ok, false);
  if (!address.ok) assert.match(address.message, /tx\.sender_address/);
});

test("a message never repeats the faulty value", () => {
  const result = validateProveBody(makeBody(123, (tx) => (tx.calldata = ["not-hex-secret-123"])));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(!result.message.includes("not-hex-secret-123"));
});
