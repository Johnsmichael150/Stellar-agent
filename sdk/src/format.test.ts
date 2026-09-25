import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { maskSecret } from "./format.js";

test("maskSecret redacts a secret key embedded in a longer message", () => {
  const secret = Keypair.random().secret();
  const message = `signing with ${secret} failed`;
  const masked = maskSecret(message);
  assert.equal(masked.includes(secret), false);
  assert.equal(masked, `signing with ${secret.slice(0, 4)}...${secret.slice(-4)} failed`);
});

test("maskSecret redacts multiple secret keys in the same string", () => {
  const a = Keypair.random().secret();
  const b = Keypair.random().secret();
  const masked = maskSecret(`${a} then ${b}`);
  assert.equal(masked.includes(a), false);
  assert.equal(masked.includes(b), false);
});

test("maskSecret leaves strings without a secret key untouched", () => {
  const message = "no secrets here, just a public key GABC2345";
  assert.equal(maskSecret(message), message);
});
