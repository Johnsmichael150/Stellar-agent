/**
 * Format an atomic Soroban token amount into a human-readable decimal string.
 *
 * Soroban tokens (SAC / Stellar Asset Contracts) track balances in atomic
 * units: `amount / 10^decimals` is the human-scale value. USDC (and most
 * Stellar classic assets) use 7 decimals, which is the default.
 *
 * All math is done with `bigint` — no floating point — so arbitrarily large
 * balances format exactly (e.g. `10^30` atomic units won't lose precision).
 *
 * @example
 * formatAmount(12_500_000n)                        // "1.25"
 * formatAmount(1n)                                 // "0.0000001"
 * formatAmount(1_234_567_890n, { group: true })    // "123.456789"
 * formatAmount(9_999_999_999n, { precision: 2 })   // "999.99"
 * formatAmount(5_000_000_000_000n, { group: true, precision: 2 }) // "500,000"
 */
export function formatAmount(
  amount: bigint,
  options: {
    /** Token decimals. Stellar assets default to 7. */
    decimals?: number;
    /** Max fractional digits to show (defaults to `decimals`, trailing zeros trimmed). */
    precision?: number;
    /** Insert thousands separators in the integer part. */
    group?: boolean;
  } = {},
): string {
  const decimals = options.decimals ?? 7;
  const precision = options.precision ?? decimals;
  if (decimals < 0 || precision < 0) {
    throw new RangeError("formatAmount: decimals and precision must be >= 0");
  }

  const factor = 10n ** BigInt(decimals);
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const whole = abs / factor;
  const frac = abs % factor;

  // Truncate to the requested precision, then strip trailing zeros.
  let fracStr = frac.toString().padStart(decimals, "0");
  if (precision < decimals) {
    fracStr = fracStr.slice(0, precision);
  }
  fracStr = fracStr.replace(/0+$/, "");

  let wholeStr = whole.toString();
  if (options.group) {
    wholeStr = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  return fracStr.length > 0 ? `${sign}${wholeStr}.${fracStr}` : `${sign}${wholeStr}`;
}

/**
 * Validate an agent metadata URI to prevent SSRF and script-injection when
 * clients later fetch it.
 *
 * Only `https://` and `ipfs://` schemes are accepted (`ipfs://` is
 * content-addressed and has no network host to resolve, so it skips the IP
 * checks below). Everything else — including `javascript:`, `data:`, and
 * `file:` — is rejected.
 *
 * For `https://` URIs, the hostname is also rejected if it is a loopback or
 * private IPv4 literal: `127.0.0.0/8`, `10.0.0.0/8`, or `169.254.0.0/16`
 * (the latter covers cloud metadata endpoints such as `169.254.169.254`).
 *
 * @example
 * isValidMetadataUri("https://ipfs.example/metadata.json") // true
 * isValidMetadataUri("ipfs://Qm...")                        // true
 * isValidMetadataUri("javascript:alert(1)")                 // false
 * isValidMetadataUri("http://169.254.169.254/latest/meta-data/") // false
 */
export function isValidMetadataUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (parsed.protocol === "ipfs:") {
    return true;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  const ipv4 = parsed.hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return false;
    const [a, b] = octets;
    if (a === 127) return false; // 127.0.0.0/8 (loopback)
    if (a === 10) return false; // 10.0.0.0/8 (private)
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 (link-local / cloud metadata)
  }

  return true;
}
