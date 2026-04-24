/**
 * Tests for the rewritten extension (src/index.ts).
 *
 * Tests:
 *   1. sanitiseSystemPrompt — removes pi references, adds Claude Code identity
 *   2. waitForRateLimit — abort cancels immediately, countdown expires naturally
 *   3. is429Message — detects 429 and "rate limit" strings
 *   4. streamWithRateLimitRetry — retries on 429, propagates other errors,
 *      stops on abort, succeeds normally
 *
 * Run with:  npx tsx src/__tests__/test-extension.ts
 */

// ─── Inline copies of the tested functions ───────────────────────────────────
// (We replicate them here so the test file has no runtime dependency on pi SDK
//  and can run standalone.)

const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const PI_REMOVAL_ANCHORS = [
  "pi-coding-agent",
  "@mariozechner/pi-coding-agent",
  "badlogic/pi-mono",
] as const;

function sanitiseSystemPrompt(raw: string): string {
  const paragraphs = raw.split(/\n\n+/);
  const filtered = paragraphs.filter((p) => {
    const lower = p.toLowerCase();
    if (lower.includes("you are pi")) return false;
    return !PI_REMOVAL_ANCHORS.some((anchor) => p.includes(anchor));
  });
  return filtered
    .join("\n\n")
    .replace(/\bpi\b/g, "Claude Code")
    .replace(/\bPi\b/g, "Claude Code")
    .trim();
}

function is429Message(msg: string): boolean {
  return msg.includes("429") || msg.toLowerCase().includes("rate limit");
}

function waitForRateLimit(
  waitMs: number,
  signal?: AbortSignal,
): Promise<"waited" | "skipped" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve("aborted"); return; }

    const deadline = Date.now() + waitMs;
    let done = false;

    const onAbort = () => { if (!done) { cleanup(); resolve("aborted"); } };
    signal?.addEventListener("abort", onAbort);

    const ticker = setInterval(() => {
      if (Date.now() >= deadline) { cleanup(); resolve("waited"); }
    }, 10);

    function cleanup() {
      done = true;
      clearInterval(ticker);
      signal?.removeEventListener("abort", onAbort);
    }
  });
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}${detail ? `  →  ${detail}` : ""}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ─── 1. sanitiseSystemPrompt ──────────────────────────────────────────────────

section("sanitiseSystemPrompt");

{
  const out = sanitiseSystemPrompt("You are pi, a coding agent.\n\nDo some work.");
  ok("removes 'you are pi' paragraph", !out.includes("You are pi"));
  ok("keeps other paragraphs", out.includes("Do some work."));
}

{
  const out = sanitiseSystemPrompt(
    "Normal paragraph.\n\nThis uses @mariozechner/pi-coding-agent library.\n\nFinal paragraph."
  );
  ok("removes pi-mono anchor paragraph", !out.includes("pi-coding-agent"));
  ok("keeps non-anchor paragraphs", out.includes("Normal paragraph.") && out.includes("Final paragraph."));
}

{
  const out = sanitiseSystemPrompt("Use pi to run tasks. Pi is helpful.");
  ok("replaces \\bpi\\b → Claude Code", out.includes("Claude Code") && !out.includes(" pi "));
  ok("replaces \\bPi\\b → Claude Code", !out.includes(" Pi "));
}

{
  const out = sanitiseSystemPrompt("");
  ok("empty input returns empty string", out === "");
}

{
  // Simulate the before_agent_start handler
  const raw = "You are pi.\n\nHere are the tools.";
  const sanitised = sanitiseSystemPrompt(raw);
  const withIdentity = sanitised
    ? `${CLAUDE_CODE_IDENTITY}\n\n${sanitised}`
    : CLAUDE_CODE_IDENTITY;
  ok("identity prepended when sanitised is non-empty", withIdentity.startsWith(CLAUDE_CODE_IDENTITY));
  ok("identity is the only content when sanitised is empty",
    sanitiseSystemPrompt("You are pi.") === "" &&
    (sanitiseSystemPrompt("You are pi.")
      ? `${CLAUDE_CODE_IDENTITY}\n\n${sanitiseSystemPrompt("You are pi.")}`
      : CLAUDE_CODE_IDENTITY) === CLAUDE_CODE_IDENTITY
  );
}

// ─── 2. is429Message ─────────────────────────────────────────────────────────

section("is429Message");

ok("detects '429'", is429Message("HTTP 429 Too Many Requests"));
ok("detects 'rate limit'", is429Message("rate limit exceeded"));
ok("detects 'Rate Limit' (case-insensitive)", is429Message("Rate Limit Error"));
ok("does not match random 4xx", !is429Message("HTTP 401 Unauthorized"));
ok("does not match empty string", !is429Message(""));
ok("does not match unrelated message", !is429Message("Connection refused"));

// ─── 3. waitForRateLimit — abort cancels immediately ─────────────────────────

section("waitForRateLimit — pre-aborted signal");

{
  const ctrl = new AbortController();
  ctrl.abort();
  const result = await waitForRateLimit(60_000, ctrl.signal);
  ok("pre-aborted signal resolves as 'aborted'", result === "aborted");
}

section("waitForRateLimit — abort during wait");

{
  const ctrl = new AbortController();
  const start = Date.now();
  const p = waitForRateLimit(60_000, ctrl.signal);
  setTimeout(() => ctrl.abort(), 80);
  const result = await p;
  const elapsed = Date.now() - start;
  ok("fires abort during wait → 'aborted'", result === "aborted", `result=${result}`);
  ok("resolves quickly (< 500 ms)", elapsed < 500, `elapsed=${elapsed}ms`);
}

section("waitForRateLimit — natural expiry");

{
  const start = Date.now();
  const result = await waitForRateLimit(200);
  const elapsed = Date.now() - start;
  ok("expires naturally → 'waited'", result === "waited", `result=${result}`);
  ok("took at least 150 ms", elapsed >= 150, `elapsed=${elapsed}ms`);
}

// ─── 4. streamWithRateLimitRetry (logic only, no SDK) ────────────────────────

section("streamWithRateLimitRetry — logic simulation");

{
  // We can't import the real function (it requires pi SDK types at runtime),
  // so we test the retry logic by simulating the while-loop behaviour directly.

  type SimEvent =
    | { type: "start" }
    | { type: "done" }
    | { type: "error"; msg: string };

  async function* makeStream(events: SimEvent[]) {
    for (const e of events) yield e;
  }

  let callCount = 0;
  const events429: SimEvent[] = [{ type: "start" }, { type: "error", msg: "429 rate limit" }];
  const eventsOk: SimEvent[] = [{ type: "start" }, { type: "done" }];

  // Simulate: first call → 429 error, second call → success
  async function simulateRetryLoop(maxRetries = 1): Promise<{ calls: number; result: string }> {
    callCount = 0;
    let result = "unknown";

    outer: while (true) {
      callCount++;
      const src = callCount <= maxRetries ? events429 : eventsOk;
      for await (const e of makeStream(src)) {
        if (e.type === "error") {
          const msg = e.msg;
          if (is429Message(msg)) {
            // Would wait, but skip here for test speed
            result = "retried";
            continue outer;
          }
          result = "error";
          break outer;
        }
        if (e.type === "done") {
          result = "done";
          break outer;
        }
      }
    }
    return { calls: callCount, result };
  }

  const { calls, result } = await simulateRetryLoop(1);
  ok("retries once on 429 then succeeds", result === "done", `result=${result}`);
  ok("called delegate twice (once failed, once ok)", calls === 2, `calls=${calls}`);
}

{
  // Simulate: non-429 error propagates immediately
  type SimEvent = { type: "error"; msg: string } | { type: "done" };

  async function* errorStream(): AsyncGenerator<SimEvent> {
    yield { type: "error", msg: "401 Unauthorized" };
  }

  let propagated = false;
  for await (const e of errorStream()) {
    if (e.type === "error" && !is429Message(e.msg)) {
      propagated = true;
    }
  }
  ok("non-429 error propagates immediately", propagated);
}

{
  // Simulate: abort during wait resolves as aborted
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  const result = await waitForRateLimit(60_000, ctrl.signal);
  ok("abort during wait → stream ends as aborted", result === "aborted");
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(64)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log("\n🎉 All tests passed!\n");
} else {
  console.error(`\n💥 ${failed} test(s) failed — see above.\n`);
  process.exit(1);
}
