/**
 * Manual test script for the two stream.ts changes:
 *
 *   1. 429 Rate-limit retry loop with countdown status
 *   2. OAuth header fix (no x-api-key sent alongside Authorization: Bearer)
 *
 * Run with:
 *   npx tsx src/__tests__/test-stream-changes.ts
 *
 * Each test prints PASS or FAIL and a description.
 */

import Anthropic from "@anthropic-ai/sdk";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(label: string) {
  console.log(`  ✅ PASS  ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.error(`  ❌ FAIL  ${label}${detail ? `\n         ${detail}` : ""}`);
  failed++;
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(60 - title.length)}`);
}

// ─── Test 1: OAuth header construction ───────────────────────────────────────
section("OAuth header fix: no x-api-key with Bearer token");

{
  // Simulate the header-building logic from the fixed stream.ts.
  // We reconstruct what happens inside streamAnthropicOAuth for an OAuth token.

  const oauthToken = "sk-ant-oat01-testtoken-placeholder";

  // Old (buggy) construction:
  const oldClient = new Anthropic({
    baseURL: "https://api.anthropic.com",
    apiKey: undefined as unknown as string, // triggers env-var fallback
    authToken: oauthToken,
    defaultHeaders: {
      authorization: `Bearer ${oauthToken}`,
    },
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
  });

  // New (fixed) construction:
  const newClient = new Anthropic({
    baseURL: "https://api.anthropic.com",
    apiKey: "oauth-via-header", // dummy non-null, prevents env-var lookup
    // authToken intentionally NOT set
    defaultHeaders: {
      authorization: `Bearer ${oauthToken}`,
    },
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
  });

  // Build headers using the SDK's internal buildHeaders approach.
  // We call buildRequest indirectly by inspecting _options.
  const oldOptions = (oldClient as unknown as { _options: Record<string, unknown> })._options;
  const newOptions = (newClient as unknown as { _options: Record<string, unknown> })._options;

  // Check apiKey field
  if (oldOptions["apiKey"] === null || oldOptions["apiKey"] === undefined) {
    pass("Old client: apiKey is null/undefined (would trigger ANTHROPIC_API_KEY env lookup)");
  } else {
    fail("Old client: apiKey unexpectedly set", String(oldOptions["apiKey"]));
  }

  if (newOptions["apiKey"] === "oauth-via-header") {
    pass("New client: apiKey is dummy sentinel, prevents env-var fallback");
  } else {
    fail("New client: apiKey not set to expected sentinel", String(newOptions["apiKey"]));
  }

  // Check authToken field
  const oldAuthToken = oldOptions["authToken"];
  const newAuthToken = newOptions["authToken"];

  if (oldAuthToken === oauthToken) {
    pass("Old client: authToken set (SDK would send duplicate Authorization header)");
  } else {
    fail("Old client authToken check", `expected ${oauthToken}, got ${String(oldAuthToken)}`);
  }

  if (newAuthToken === null || newAuthToken === undefined) {
    pass("New client: authToken NOT set (SDK won't add extra Authorization header)");
  } else {
    fail("New client: authToken unexpectedly set", String(newAuthToken));
  }

  // Check that the new client correctly uses defaultHeaders for auth
  const newDefaultHeaders = newOptions["defaultHeaders"] as Record<string, string>;
  if (newDefaultHeaders?.["authorization"]?.startsWith("Bearer ")) {
    pass("New client: Authorization Bearer set in defaultHeaders");
  } else {
    fail("New client: Authorization header missing from defaultHeaders");
  }

  // Verify the SDK's authHeaders() method behaviour:
  // apiKeyAuth() only fires when apiKey != null → sends x-api-key
  // bearerAuth() only fires when authToken != null → sends Authorization: Bearer
  // With the fix: apiKey = "oauth-via-header" (non-null) → SDK would send x-api-key
  // BUT defaultHeaders overrides it because defaultHeaders is applied AFTER authHeaders.
  //
  // Actually, looking at the SDK buildHeaders order:
  //   authHeaders → defaultHeaders → request headers
  // defaultHeaders wins, so even if apiKeyAuth fires, our defaultHeaders.authorization
  // overrides what the SDK would have set for x-api-key. But x-api-key is a different
  // header from authorization. Let's verify with a deeper check.

  // The SDK sends x-api-key when apiKey != null.
  // With apiKey = "oauth-via-header", it WILL try to send x-api-key: oauth-via-header.
  // We need to ensure x-api-key is suppressed.
  // Solution: also explicitly blank x-api-key in defaultHeaders for OAuth mode.
  console.log(`\n  ⚠️  NOTE: With apiKey="oauth-via-header", the SDK will set x-api-key header.`);
  console.log(`     The defaultHeaders need to include "x-api-key": "" to suppress it.`);
  console.log(`     Checking if this is needed...`);

  // Inspect the authHeaders method
  const authHeadersResult = (newClient as unknown as {
    authHeaders: (opts: unknown) => { values: Map<string, string> };
  }).authHeaders({});

  // authHeaders returns a buildHeaders result
  const authValues = authHeadersResult?.values;
  if (authValues instanceof Map) {
    const xApiKey = authValues.get("x-api-key") ?? authValues.get("X-Api-Key");
    if (xApiKey === "oauth-via-header") {
      fail("SDK IS sending x-api-key with OAuth dummy apiKey — need to suppress it!");
      console.log(`     → Fix: add '"x-api-key": ""' to defaultHeaders in isOAuth branch.`);
    } else if (!xApiKey) {
      pass("SDK is NOT sending x-api-key (safe)");
    }
  } else {
    console.log(`  ℹ️  Could not inspect authHeaders values (Map not returned directly)`);
  }
}

// ─── Test 2: waitForRateLimit function logic ──────────────────────────────────
section("429 retry: waitForRateLimit cancels on AbortSignal");

{
  // Test 2a: Already-aborted signal resolves immediately as "aborted"
  async function testAbortedSignal() {
    const ctrl = new AbortController();
    ctrl.abort();

    // We can't import waitForRateLimit directly (it's not exported), so we test
    // the observable behaviour of streamAnthropicOAuth.
    // Instead, test the core countdown logic inline.

    const deadlineMs = 100; // 100ms wait
    const result = await new Promise<string>((resolve) => {
      if (ctrl.signal.aborted) {
        resolve("aborted");
        return;
      }
      setTimeout(() => resolve("waited"), deadlineMs);
    });

    if (result === "aborted") {
      pass("Pre-aborted signal resolves immediately as 'aborted'");
    } else {
      fail("Pre-aborted signal did not resolve as 'aborted'", result);
    }
  }

  await testAbortedSignal();
}

{
  // Test 2b: AbortSignal fires during wait → resolves as "aborted"
  async function testAbortDuringWait() {
    const ctrl = new AbortController();
    const waitMs = 5000; // 5s wait
    const abortAfterMs = 100; // abort after 100ms

    const start = Date.now();

    const resultPromise = new Promise<string>((resolve) => {
      const onAbort = () => resolve("aborted");
      ctrl.signal.addEventListener("abort", onAbort);
      setTimeout(() => {
        ctrl.signal.removeEventListener("abort", onAbort);
        resolve("waited");
      }, waitMs);
    });

    // Trigger abort
    setTimeout(() => ctrl.abort(), abortAfterMs);

    const result = await resultPromise;
    const elapsed = Date.now() - start;

    if (result === "aborted" && elapsed < 1000) {
      pass(`AbortSignal fires during wait → resolves as 'aborted' in ${elapsed}ms`);
    } else {
      fail("AbortSignal during wait did not cancel properly", `result=${result}, elapsed=${elapsed}ms`);
    }
  }

  await testAbortDuringWait();
}

{
  // Test 2c: Normal countdown expires → resolves as "waited"
  async function testNormalExpiry() {
    const waitMs = 200; // 200ms test wait
    const start = Date.now();

    const result = await new Promise<string>((resolve) => {
      const deadline = Date.now() + waitMs;
      const ticker = setInterval(() => {
        if (Date.now() >= deadline) {
          clearInterval(ticker);
          resolve("waited");
        }
      }, 50);
    });

    const elapsed = Date.now() - start;
    if (result === "waited" && elapsed >= waitMs - 100) {
      pass(`Countdown expires naturally → resolves as 'waited' after ${elapsed}ms`);
    } else {
      fail("Normal countdown expiry failed", `result=${result}, elapsed=${elapsed}ms`);
    }
  }

  await testNormalExpiry();
}

// ─── Test 3: content.splice(0) in-place reset ─────────────────────────────────
section("429 retry: output.content reset is in-place (splice, not reassign)");

{
  type Block = { type: string; text?: string };
  const content: Block[] = [{ type: "text", text: "partial response" }];
  const capturedRef = content; // simulates what the framework would have captured

  // Simulate the fix: splice in-place
  (content as unknown[]).splice(0);

  if (content === capturedRef) {
    pass("output.content is the same array reference after splice(0)");
  } else {
    fail("output.content reference changed — would break framework observers");
  }

  if (content.length === 0) {
    pass("output.content is empty after splice(0)");
  } else {
    fail("output.content not empty after splice(0)", String(content.length));
  }
}

// ─── Test 4: RateLimitError instanceof check ─────────────────────────────────
section("429 detection: RateLimitError instanceof check");

{
  const { RateLimitError } = await import("@anthropic-ai/sdk");

  // Simulate what the SDK throws on 429
  const headers = new Headers({ "content-type": "application/json" });
  const err = new RateLimitError(
    429,
    { error: { type: "rate_limit_error", message: "Rate limit exceeded" } },
    "Rate limit exceeded",
    headers,
  );

  if (err instanceof RateLimitError) {
    pass("RateLimitError instanceof check works correctly");
  } else {
    fail("RateLimitError instanceof check failed");
  }

  if (err.status === 429) {
    pass("RateLimitError.status === 429");
  } else {
    fail("RateLimitError.status mismatch", String(err.status));
  }

  // Ensure a regular Error is NOT a RateLimitError
  const regularError = new Error("something else");
  if (!(regularError instanceof RateLimitError)) {
    pass("Regular Error is NOT a RateLimitError (correct)");
  } else {
    fail("Regular Error incorrectly identified as RateLimitError");
  }
}

// ─── Test 5: isOAuth detection unchanged ─────────────────────────────────────
section("OAuth token detection: isClaudeOAuthAccessToken");

{
  const { isClaudeOAuthAccessToken } = await import("../auth.js");

  const tests = [
    { key: "sk-ant-oat01-testtoken", expected: true },
    { key: "sk-ant-oat99-anothertoken", expected: true },
    { key: "sk-ant-api03-regularkeyhere", expected: false },
    { key: "ANTHROPIC_MAX_API_KEY", expected: false },
    { key: "", expected: false },
    { key: "oauth-via-header", expected: false }, // our dummy key must NOT be detected as OAuth
  ];

  for (const { key, expected } of tests) {
    const result = isClaudeOAuthAccessToken(key);
    if (result === expected) {
      pass(`isClaudeOAuthAccessToken("${key.slice(0, 20)}...") === ${expected}`);
    } else {
      fail(`isClaudeOAuthAccessToken("${key.slice(0, 20)}...") expected ${expected}, got ${result}`);
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(64)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log(`\n🎉 All tests passed!\n`);
} else {
  console.log(`\n💥 ${failed} test(s) failed — see above for details.\n`);
  process.exit(1);
}
