/**
 * Automated integration test verifying full x402 payment flow between
 * buyer agent (marcFetch) and mock seller agent (marcPaywall in Express).
 *
 * Issue #596:
 * - Spins up an ephemeral Express app with marcPaywall.
 * - Confirms first request receives 402 with X-Payment-Requirements.
 * - Issues request using marcFetch with a test keypair.
 * - Asserts marcFetch intercepts 402, constructs signed payment, and retries.
 * - Asserts server validates payment and returns 200 with resource body.
 * - Closes server after test completes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { marcPaywall } from "./marcPaywall.js";
import { marcFetch } from "./marcFetch.js";

const originalFetch = globalThis.fetch;

function stubFacilitatorFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/supported")) {
      return new Response(
        JSON.stringify({
          kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
          extensions: [],
          signers: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/verify")) {
      return new Response(
        JSON.stringify({
          isValid: true,
          payer: "GBUYERMOCKTESTKEYPAIR1234567890",
          extensions: {},
          extra: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/settle")) {
      return new Response(
        JSON.stringify({
          success: true,
          payer: "GBUYERMOCKTESTKEYPAIR1234567890",
          transaction: "mock_stellar_tx_hash",
          network: "stellar:testnet",
          extensions: {},
          extra: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test("x402 integration: verifies complete payment roundtrip between buyer and mock seller", async () => {
  stubFacilitatorFetch();

  const sellerKeypair = Keypair.random();
  const buyerKeypair = Keypair.random();

  const app = express();
  app.use(express.json());

  let totalRequestsReceived = 0;
  const paywall = marcPaywall({
    payTo: sellerKeypair.publicKey(),
    price: "$0.01",
    network: "stellar:testnet",
  });

  app.get(
    "/api/resource",
    (req, res, next) => {
      totalRequestsReceived += 1;
      paywall(req, res, next);
    },
    (_req, res) => {
      res.status(200).json({
        status: "ok",
        resource: "premium-agent-output",
        access: "granted",
      });
    },
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const address = server.address() as { port: number };
  const resourceUrl = `http://127.0.0.1:${address.port}/api/resource`;

  try {
    // 1. Assert raw initial request receives 402 with X-Payment-Requirements
    const rawRes = await fetch(resourceUrl);
    assert.equal(rawRes.status, 402, "Initial request must receive HTTP 402 Payment Required");

    const paymentReqHeader =
      rawRes.headers.get("x-payment-requirements") ||
      rawRes.headers.get("X-Payment-Requirements") ||
      rawRes.headers.get("payment-required");

    assert.ok(
      paymentReqHeader,
      "Response must include X-Payment-Requirements or PAYMENT-REQUIRED header",
    );

    // 2. Issue request using marcFetch with buyer test keypair
    const paymentStages: string[] = [];
    const clientFetch = marcFetch({
      signer: buyerKeypair,
      network: "testnet",
      maxPaymentAttempts: 2,
      onPayment: (status) => {
        paymentStages.push(status);
      },
    });

    const paidRes = await clientFetch(resourceUrl);

    // 3. Assert server validates payment and returns 200 with resource body
    assert.equal(paidRes.status, 200, "Authenticated request must return HTTP 200 OK");
    const data = (await paidRes.json()) as { status: string; resource: string; access: string };

    assert.equal(data.status, "ok");
    assert.equal(data.resource, "premium-agent-output");
    assert.equal(data.access, "granted");

    // 4. Assert payment lifecycle callbacks
    assert.ok(
      paymentStages.includes("signing"),
      "Payment lifecycle must transition through 'signing'",
    );
    assert.ok(
      paymentStages.includes("pending"),
      "Payment lifecycle must transition through 'pending'",
    );
    assert.ok(
      paymentStages.includes("settled"),
      "Payment lifecycle must transition through 'settled'",
    );

    // Total requests received by the Express app must be at least 2 (initial 402 + retried 200)
    assert.ok(totalRequestsReceived >= 2, "Server must receive initial request and payment retry");
  } finally {
    restoreFetch();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
