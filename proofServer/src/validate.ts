import { INVOKE_TXN_V3 } from "@starknet-io/starknet-types-0101";
import {
  EDataAvailabilityMode,
  ETransactionVersion,
  TransactionType,
  constants,
  num,
  validateAndParseAddress,
} from "starknet";

export const MAX_CALLDATA = 5000;

export type BodyCheck = { ok: true; blockNumber: number; tx: INVOKE_TXN_V3 } | { ok: false; message: string };

const BOUND_NAMES = ["l1_gas", "l2_gas", "l1_data_gas"] as const;
const MAX_HEX_LENGTH = 66; // "0x" and 64 digits; tested first so that no huge number is ever parsed

class BodyError extends Error {}

// The message names the field and never repeats its value: the calldata holds the voter's secret.
function fail(message: string): never {
  throw new BodyError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A felt written as a hex string: below the prime of the field, which a count of digits cannot ensure.
function isFelt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 2 &&
    value.length <= MAX_HEX_LENGTH &&
    num.isHex(value) &&
    num.toBigInt(value) < constants.PRIME
  );
}

function hex(at: string, value: unknown): string {
  if (!isFelt(value)) fail(`${at}: expected a felt as a hex string (0x…)`);
  return value;
}

function address(at: string, value: unknown): string {
  const text = hex(at, value);
  try {
    validateAndParseAddress(text);
  } catch {
    fail(`${at}: not a valid Starknet address`);
  }
  return text;
}

function hexArray(at: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CALLDATA || !value.every(isFelt)) {
    fail(`${at}: expected an array of at most ${MAX_CALLDATA} felts as hex strings`);
  }
  return value as string[];
}

function daMode(at: string, value: unknown): "L1" | "L2" {
  if (value !== EDataAvailabilityMode.L1 && value !== EDataAvailabilityMode.L2) {
    fail(`${at}: expected "${EDataAvailabilityMode.L1}" or "${EDataAvailabilityMode.L2}"`);
  }
  return value as "L1" | "L2";
}

// Strict on purpose: num.toBigInt would also accept "" (as 0), " 12 " and "0b11".
function blockNumber(value: unknown): number {
  let n: number | undefined;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && (/^\d+$/.test(value) || /^0x[0-9a-fA-F]+$/.test(value))) n = Number(value);
  if (n === undefined || !Number.isSafeInteger(n) || n < 0) {
    fail("blockNumber: expected a non-negative integer (a number, or a decimal or 0x-hex string)");
  }
  return n;
}

function resourceBounds(value: unknown): Record<string, { max_amount: string; max_price_per_unit: string }> {
  if (!isRecord(value)) fail("tx.resource_bounds: expected an object with l1_gas, l2_gas and l1_data_gas");
  const bounds: Record<string, { max_amount: string; max_price_per_unit: string }> = {};
  for (const name of BOUND_NAMES) {
    const at = `tx.resource_bounds.${name}`;
    const bound = value[name];
    if (!isRecord(bound)) fail(`${at}: expected an object with max_amount and max_price_per_unit (hex strings)`);
    bounds[name] = {
      max_amount: hex(`${at}.max_amount`, bound.max_amount),
      max_price_per_unit: hex(`${at}.max_price_per_unit`, bound.max_price_per_unit),
    };
  }
  return bounds;
}

// The transaction is rebuilt from the fields of an INVOKE v3: anything else sent along is dropped.
export function validateProveBody(body: unknown): BodyCheck {
  try {
    if (!isRecord(body)) fail("body: expected a JSON object");
    const block = blockNumber(body.blockNumber);
    const raw = body.tx;
    if (!isRecord(raw)) fail("tx: expected an object");
    if (raw.type !== TransactionType.INVOKE) fail(`tx.type: expected "${TransactionType.INVOKE}"`);
    if (raw.version !== ETransactionVersion.V3) fail(`tx.version: expected "${ETransactionVersion.V3}"`);
    const tx = {
      type: TransactionType.INVOKE,
      sender_address: address("tx.sender_address", raw.sender_address),
      calldata: hexArray("tx.calldata", raw.calldata),
      version: ETransactionVersion.V3,
      signature: hexArray("tx.signature", raw.signature),
      nonce: hex("tx.nonce", raw.nonce),
      resource_bounds: resourceBounds(raw.resource_bounds),
      tip: hex("tx.tip", raw.tip),
      paymaster_data: hexArray("tx.paymaster_data", raw.paymaster_data),
      account_deployment_data: hexArray("tx.account_deployment_data", raw.account_deployment_data),
      nonce_data_availability_mode: daMode("tx.nonce_data_availability_mode", raw.nonce_data_availability_mode),
      fee_data_availability_mode: daMode("tx.fee_data_availability_mode", raw.fee_data_availability_mode),
    };
    return { ok: true, blockNumber: block, tx: tx as unknown as INVOKE_TXN_V3 };
  } catch (err) {
    if (err instanceof BodyError) return { ok: false, message: err.message };
    throw err;
  }
}
