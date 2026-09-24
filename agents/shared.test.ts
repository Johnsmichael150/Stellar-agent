import assert from "node:assert/strict";
import test from "node:test";
import { makeSellerResponse, retryWithBackoff, validateEnv } from "./shared.js";

test("makeSellerResponse - returns standard response format with success true and execution_time_ms >= 0", () => {
  const payload = { result: "test-data", count: 42 };
  const response = makeSellerResponse(payload);

  assert.equal(response.success, true);
  assert.deepEqual(response.data, payload);
  assert.equal(typeof response.execution_time_ms, "number");
  assert.ok(response.execution_time_ms >= 0);
});

test("makeSellerResponse - correctly computes execution_time_ms with given startTime", () => {
  const startTime = Date.now() - 150;
  const response = makeSellerResponse("hello", startTime);

  assert.equal(response.success, true);
  assert.equal(response.data, "hello");
  assert.ok(response.execution_time_ms >= 140);
});

test("validateEnv - passes when all required environment variables are set", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.REGISTRY_URL = "http://localhost:4500";
    process.env.GROQ_API_KEY = "gsk_test123";

    // Should not throw or exit
    assert.doesNotThrow(() => {
      validateEnv(["REGISTRY_URL", "GROQ_API_KEY"]);
    });
  } finally {
    process.env = originalEnv;
  }
});

test("validateEnv - detects missing environment variables and exits with code 1", () => {
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalError = console.error;

  let exitCalled = false;
  let exitCode: number | undefined;

  // @ts-ignore
  process.exit = (code?: number) => {
    exitCalled = true;
    exitCode = code;
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};

  try {
    delete process.env.NON_EXISTENT_VAR_12345;
    assert.throws(
      () => validateEnv(["NON_EXISTENT_VAR_12345"]),
      /process.exit called with 1/,
    );
    assert.equal(exitCalled, true);
    assert.equal(exitCode, 1);
  } finally {
    process.env = originalEnv;
    process.exit = originalExit;
    console.error = originalError;
  }
});

test("validateEnv - treats empty or whitespace-only variables as missing", () => {
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalError = console.error;

  let exitCalled = false;

  // @ts-ignore
  process.exit = (code?: number) => {
    exitCalled = true;
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};

  try {
    process.env.EMPTY_TEST_VAR = "   ";
    assert.throws(
      () => validateEnv(["EMPTY_TEST_VAR"]),
      /process.exit called with 1/,
    );
    assert.equal(exitCalled, true);
  } finally {
    process.env = originalEnv;
    process.exit = originalExit;
    console.error = originalError;
  }
});

test("validateEnv - handles aliases correctly for PORT (PORT or SELLER_PORT)", () => {
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalError = console.error;

  // @ts-ignore
  process.exit = (code?: number) => {
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};

  try {
    // Case 1: Only PORT is set
    delete process.env.SELLER_PORT;
    process.env.PORT = "4501";
    assert.doesNotThrow(() => validateEnv(["PORT"]));

    // Case 2: Only SELLER_PORT is set
    delete process.env.PORT;
    process.env.SELLER_PORT = "4502";
    assert.doesNotThrow(() => validateEnv(["PORT"]));

    // Case 3: Both set
    process.env.PORT = "4501";
    process.env.SELLER_PORT = "4502";
    assert.doesNotThrow(() => validateEnv(["PORT"]));

    // Case 4: Neither set -> fails
    delete process.env.PORT;
    delete process.env.SELLER_PORT;
    assert.throws(() => validateEnv(["PORT"]), /process.exit called with 1/);
  } finally {
    process.env = originalEnv;
    process.exit = originalExit;
    console.error = originalError;
  }
});

test("validateEnv - handles aliases correctly for SECRET_KEY (SECRET_KEY or SELLER_SECRET)", () => {
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const originalError = console.error;

  // @ts-ignore
  process.exit = (code?: number) => {
    throw new Error(`process.exit called with ${code}`);
  };
  console.error = () => {};

  try {
    // Case 1: Only SECRET_KEY is set
    delete process.env.SELLER_SECRET;
    process.env.SECRET_KEY = "S_TEST_SECRET_1";
    assert.doesNotThrow(() => validateEnv(["SECRET_KEY"]));

    // Case 2: Only SELLER_SECRET is set
    delete process.env.SECRET_KEY;
    process.env.SELLER_SECRET = "S_TEST_SECRET_2";
    assert.doesNotThrow(() => validateEnv(["SECRET_KEY"]));

    // Case 3: Both set
    process.env.SECRET_KEY = "S_TEST_SECRET_1";
    process.env.SELLER_SECRET = "S_TEST_SECRET_2";
    assert.doesNotThrow(() => validateEnv(["SECRET_KEY"]));

    // Case 4: Neither set -> fails
    delete process.env.SECRET_KEY;
    delete process.env.SELLER_SECRET;
    assert.throws(() => validateEnv(["SECRET_KEY"]), /process.exit called with 1/);
  } finally {
    process.env = originalEnv;
    process.exit = originalExit;
    console.error = originalError;
  }
});

test("retryWithBackoff - resolves immediately on first try if successful", async () => {
  let attempts = 0;
  const result = await retryWithBackoff(async () => {
    attempts++;
    return "ok";
  }, { maxAttempts: 3, baseDelayMs: 1 });

  assert.equal(result, "ok");
  assert.equal(attempts, 1);
});

test("retryWithBackoff - retries on error and successfully resolves after transient failure", async () => {
  let attempts = 0;
  const originalError = console.error;
  console.error = () => {}; // suppress retry logs during test

  try {
    const result = await retryWithBackoff(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error(`transient error attempt ${attempts}`);
      }
      return "recovered";
    }, { maxAttempts: 5, baseDelayMs: 1 });

    assert.equal(result, "recovered");
    assert.equal(attempts, 3);
  } finally {
    console.error = originalError;
  }
});

test("retryWithBackoff - throws error after exhausting all maxAttempts", async () => {
  let attempts = 0;
  const originalError = console.error;
  console.error = () => {}; // suppress retry logs during test

  try {
    await assert.rejects(
      async () => {
        await retryWithBackoff(async () => {
          attempts++;
          throw new Error("persistent failure");
        }, { maxAttempts: 3, baseDelayMs: 1, label: "test" });
      },
      /persistent failure/,
    );

    assert.equal(attempts, 3);
  } finally {
    console.error = originalError;
  }
});
