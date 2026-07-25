import { Keypair } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import {
  createEd25519Signer,
  STELLAR_TESTNET_CAIP2,
  STELLAR_PUBNET_CAIP2,
} from "@x402/stellar";

/** Payment lifecycle status passed to the onPayment callback. */
export type PaymentStatus = "signing" | "pending" | "settled" | "failed";

/**
 * Configuration options for the auto-paying marcFetch wrapper.
 *
 * Controls how payment transactions are built, which network is used, and
 * provides optional callbacks for monitoring payment progress.
 */
export interface MarcFetchOptions {
  /** Keypair used to sign payment transactions. */
  signer: Keypair;
  /** Soroban RPC URL for submitting payments. */
  rpcUrl?: string;
  /** Network: testnet or pubnet. Default: testnet. */
  network?: "testnet" | "pubnet";
  /** Custom HTTP headers forwarded on every request (e.g. API keys, auth tokens). */
  headers?: Record<string, string>;
  /** Optional callback invoked with payment lifecycle status for progress UI. */
  onPayment?: (status: PaymentStatus) => void;
  /** Max time per HTTP attempt before aborting. Default: 30000 ms. */
  timeoutMs?: number;
  /** Max payment retries for the same (url, price) pair. Default: 1. */
  maxPaymentAttempts?: number;
  /** Optional fetch implementation override, useful for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAYMENT_ATTEMPTS = 1;

export interface ParsedPaymentRequired {
  amount?: string;
  asset?: string;
}

export function parsePaymentRequiredHeader(headerValue: string): ParsedPaymentRequired {
  const decoded = decodePaymentRequiredHeader(headerValue);
  const first = decoded.accepts?.[0];
  return {
    amount: first?.amount,
    asset: first?.asset,
  };
}

function withTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const mergedSignal = init?.signal;
    const abortHandler = () => controller.abort();

    if (mergedSignal) {
      if (mergedSignal.aborted) controller.abort();
      else mergedSignal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      return await Promise.race([
        fetchImpl(input, { ...init, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            controller.abort();
            reject(new Error(`marcFetch timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      if (controller.signal.aborted && err instanceof Error && err.message.includes("timeout")) {
        throw err;
      }
      if (controller.signal.aborted) {
        throw new Error(`marcFetch timeout after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      if (mergedSignal) mergedSignal.removeEventListener("abort", abortHandler);
    }
  };
}

function mergeHeaders(
  baseHeaders: Record<string, string> | undefined,
  initHeaders: HeadersInit | undefined,
  extraHeaders: Record<string, string> = {},
): Headers {
  const headers = new Headers(initHeaders);
  if (baseHeaders) {
    for (const [k, v] of Object.entries(baseHeaders)) headers.set(k, v);
  }
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return headers;
}

/**
 * Reusable x402 fetch client with connection pooling.
 *
 * Wraps the native `fetch` function to intercept 402 "Payment Required" responses.
 * When a 402 is received, the wrapper automatically:
 * 1. Parses payment requirements from response headers
 * 2. Builds and signs a Stellar payment transaction
 * 3. Submits the payment via Soroban
 * 4. Retries the original request with payment proof headers
 *
 * Uses the x402 v2 protocol with @x402/fetch and @x402/stellar libraries.
 *
 * @example
 * ```typescript
 * const client = marcFetch({
 *   signer: myKeypair,
 *   network: "testnet",
 *   onPayment: (status) => console.log(`Payment: ${status}`),
 * });
 * const response = await client.fetch("https://api.example.com/protected");
 * await client.close();
 * ```
 */
export class MarcFetchClient {
  private client: x402Client;
  private httpClient: x402HTTPClient;
  private fetchWithTimeout: ReturnType<typeof withTimeout>;
  private paymentAttemptCache: Map<string, number>;

  constructor(private opts: MarcFetchOptions) {
    const {
      signer,
      rpcUrl,
      network = "testnet",
      timeoutMs = DEFAULT_TIMEOUT_MS,
      fetchImpl = fetch,
    } = opts;

    const caip2 =
      network === "pubnet" ? STELLAR_PUBNET_CAIP2 : STELLAR_TESTNET_CAIP2;

    const stellarSigner = createEd25519Signer(signer.secret(), caip2);

    const rpcConfig = rpcUrl ? { url: rpcUrl } : undefined;
    const stellarScheme = new ExactStellarScheme(stellarSigner, rpcConfig);

    this.client = new x402Client();
    this.client.register(caip2, stellarScheme);
    this.httpClient = new x402HTTPClient(this.client);
    this.fetchWithTimeout = withTimeout(fetchImpl, timeoutMs);
    this.paymentAttemptCache = new Map<string, number>();
  }

  /**
   * Perform a fetch request with automatic 402 payment handling.
   */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { headers: customHeaders, onPayment, maxPaymentAttempts = DEFAULT_MAX_PAYMENT_ATTEMPTS } = this.opts;

    const request = new Request(input, {
      ...init,
      headers: mergeHeaders(customHeaders, init?.headers),
    });

    let response = await this.fetchWithTimeout(request.clone());
    if (response.status !== 402) {
      return response;
    }

    while (response.status === 402) {
      const requiredHeader = response.headers.get("PAYMENT-REQUIRED") ?? response.headers.get("X-PAYMENT-REQUIREMENTS");
      if (!requiredHeader) {
        throw new Error("402 response missing payment requirements header");
      }

      const parsed = parsePaymentRequiredHeader(requiredHeader);
      const url = new URL(request.url).toString();
      const cacheKey = `${url}|${parsed.asset ?? "unknown-asset"}|${parsed.amount ?? "unknown-amount"}`;
      const attempts = this.paymentAttemptCache.get(cacheKey) ?? 0;
      if (attempts >= maxPaymentAttempts) {
        throw new Error(`max payment attempts reached for ${url}`);
      }
      this.paymentAttemptCache.set(cacheKey, attempts + 1);

      const paymentRequired = this.httpClient.getPaymentRequiredResponse((name) => response.headers.get(name));

      try {
        onPayment?.("signing");
        const payload = await this.client.createPaymentPayload(paymentRequired);
        onPayment?.("pending");

        const paymentHeaders = this.httpClient.encodePaymentSignatureHeader(payload);
        const paidRequest = new Request(input, {
          ...init,
          headers: mergeHeaders(customHeaders, init?.headers, paymentHeaders),
        });
        paidRequest.headers.set("Access-Control-Expose-Headers", "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE");

        response = await this.fetchWithTimeout(paidRequest);
        await this.httpClient.processPaymentResult(
          payload,
          (name) => response.headers.get(name),
          response.status,
        );

        if (response.status !== 402) {
          onPayment?.("settled");
          this.paymentAttemptCache.delete(cacheKey);
          return response;
        }
      } catch (err) {
        onPayment?.("failed");
        throw err;
      }
    }

    return response;
  }

  /**
   * Clean up resources.
   * Call this when the client is no longer needed.
   */
  close(): void {
    this.paymentAttemptCache.clear();
  }
}

/**
 * Create a fetch wrapper that automatically handles HTTP 402 payment responses.
 *
 * @param opts - Configuration including signer keypair, RPC URL, and network
 * @returns A MarcFetchClient with fetch() and close() methods
 *
 * @example
 * ```typescript
 * const client = marcFetch({
 *   signer: myKeypair,
 *   network: "testnet",
 *   onPayment: (status) => console.log(`Payment: ${status}`),
 * });
 * const response = await client.fetch("https://api.example.com/protected");
 * await client.close();
 * ```
 */
export function marcFetch(opts: MarcFetchOptions): MarcFetchClient {
  return new MarcFetchClient(opts);
}
