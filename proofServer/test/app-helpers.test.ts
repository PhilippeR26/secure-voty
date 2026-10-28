import assert from "node:assert/strict";
import test from "node:test";
import { clientIp, isLanAddress } from "../src/app";

test("isLanAddress", () => {
  for (const addr of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "::1",
    "::ffff:192.168.1.20",
  ]) {
    assert.equal(isLanAddress(addr), true, addr);
  }
  for (const addr of ["172.32.0.1", "8.8.8.8", "2a01:e0a::1", "", undefined]) {
    assert.equal(isLanAddress(addr), false, String(addr));
  }
});

test("isLanAddress refuses what only looks private", () => {
  for (const addr of ["172.15.0.1", "192.169.0.1", "11.0.0.1", "256.1.1.1", "10.0.0.1.5", "::ffff:8.8.8.8", "localhost"]) {
    assert.equal(isLanAddress(addr), false, addr);
  }
});

test("clientIp", () => {
  assert.equal(clientIp("1.2.3.4", "127.0.0.1"), "1.2.3.4");
  assert.equal(clientIp("9.9.9.9, 1.2.3.4", "127.0.0.1"), "1.2.3.4");
  assert.equal(clientIp(undefined, "127.0.0.1"), "127.0.0.1");
  assert.equal(clientIp(undefined, undefined), "unknown");
  assert.equal(clientIp("", "127.0.0.1"), "127.0.0.1");
});
