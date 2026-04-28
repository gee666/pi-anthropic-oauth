import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getApiProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

// ─── Constants ────────────────────────────────────────────────────────────────

const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const PI_REMOVAL_ANCHORS = [
  "pi-coding-agent",
  "@mariozechner/pi-coding-agent",
  "badlogic/pi-mono",
] as const;

const PI_IDENTITY_SENTENCE_PATTERN =
  /(?:^|\n)\s*You are pi\b[^.!?\n]*(?:[.!?](?=\s|$)|(?=\n|$))/gi;

const DEFAULT_RATE_LIMIT_WAIT_MS = 30 * 60 * 1_000; // 30 minutes

/** Key used with ctx.ui.setStatus() for the countdown line. */
const STATUS_KEY = "rate-limit";

// ─── Shared UI context ────────────────────────────────────────────────────────

let sharedCtx: ExtensionContext | undefined;
let restoreFetch: (() => void) | undefined;
let ambientStatusCleanup: (() => void) | undefined;
let activeAnthropicSubscriptionRequests = 0;
const oauthAnthropicModelIds = new Set<string>();

// ─── Prompt sanitisation ──────────────────────────────────────────────────────

export function sanitiseSystemPrompt(raw: string): string {
  const paragraphs = raw.split(/\n\n+/);
  const filtered = paragraphs.filter((p) =>
    !PI_REMOVAL_ANCHORS.some((anchor) => p.includes(anchor)),
  );

  return filtered
    .join("\n\n")
    .replace(PI_IDENTITY_SENTENCE_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isOAuthApiKey(apiKey: string | undefined): boolean {
  return apiKey?.includes("sk-ant-oat") ?? false;
}

function isAnthropicSubscriptionModel(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return Boolean(
    model &&
    model.provider === "anthropic" &&
    ctx.modelRegistry.isUsingOAuth(model),
  );
}

function isAnthropicSubscriptionRequest(
  model: Model<Api>,
  options?: SimpleStreamOptions,
): boolean {
  if (model.provider !== "anthropic") return false;
  if (options?.apiKey) return isOAuthApiKey(options.apiKey);
  return oauthAnthropicModelIds.has(model.id);
}

// ─── Rate-limit detection ───────────────────────────────────────────────────
// Anthropic/OAuth rate limit failures do not always stringify as plain
// "HTTP 429". Depending on where the error is created, Pi may only see the SDK
// message ("rate_limit_error", "Too Many Requests", "quota exceeded", etc.).
// Keep this intentionally focused on common rate-limit terms so unrelated 4xx
// errors still propagate normally.

export function isRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    /(?:^|\D)429(?:\D|$)/.test(msg) ||
    lower.includes("rate_limit") ||
    /rate\s*limit/.test(lower) ||
    lower.includes("too many requests") ||
    lower.includes("quota exceeded") ||
    lower.includes("quota will reset") ||
    lower.includes("retry delay") ||
    lower.includes("retry-after")
  );
}

export function parseRetryDelayMs(msg: string): number | undefined {
  const retryAfter = msg.match(/retry-after(?:-ms)?[^0-9]*(\d+(?:\.\d+)?)/i);
  if (retryAfter?.[1]) {
    const value = Number(retryAfter[1]);
    if (Number.isFinite(value) && value > 0) {
      return msg.toLowerCase().includes("retry-after-ms") ? value : value * 1_000;
    }
  }

  const requested = msg.match(/requested\s+(\d+(?:\.\d+)?)s\s+retry delay/i);
  if (requested?.[1]) {
    const value = Number(requested[1]);
    if (Number.isFinite(value) && value > 0) return value * 1_000;
  }

  const retryIn = msg.match(/retry\s+in\s+(\d+(?:\.\d+)?)(ms|s|m|h)/i);
  if (retryIn?.[1] && retryIn[2]) {
    const value = Number(retryIn[1]);
    if (Number.isFinite(value) && value > 0) {
      const unit = retryIn[2].toLowerCase();
      if (unit === "ms") return value;
      if (unit === "s") return value * 1_000;
      if (unit === "m") return value * 60_000;
      if (unit === "h") return value * 3_600_000;
    }
  }

  const resetAfter = msg.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (resetAfter) {
    const hours = resetAfter[1] ? Number(resetAfter[1]) : 0;
    const mins = resetAfter[2] ? Number(resetAfter[2]) : 0;
    const secs = Number(resetAfter[3]);
    if ([hours, mins, secs].every(Number.isFinite)) {
      return ((hours * 60 + mins) * 60 + secs) * 1_000;
    }
  }

  return undefined;
}

export function rateLimitWaitMs(msg: string): number {
  return parseRetryDelayMs(msg) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
}

export function retryAfterHeaderMs(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs) {
    const value = Number(retryAfterMs);
    if (Number.isFinite(value) && value > 0) return value;
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;

  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return undefined;
}

// ─── Rate-limit countdown ─────────────────────────────────────────────────────

function statusText(waitMs: number, deadline: number, allowSkip: boolean): string {
  const remaining = Math.max(0, deadline - Date.now());
  const totalSecs = Math.ceil(remaining / 1_000);
  const mins = Math.floor(totalSecs / 60);
  const secs = (totalSecs % 60).toString().padStart(2, "0");
  return (
    `⏳ Rate limited — next retry in ${mins}m ${secs}s` +
    (allowSkip ? "  (Enter to retry now)" : "")
  );
}

function showAmbientRateLimitStatus(waitMs: number): void {
  const ctx = sharedCtx;
  if (!ctx) return;

  ambientStatusCleanup?.();

  if (waitMs <= 0) return;

  const deadline = Date.now() + waitMs;
  const tick = () => {
    if (Date.now() >= deadline) {
      ambientStatusCleanup?.();
      return;
    }
    const text = statusText(waitMs, deadline, false);
    ctx.ui.setStatus(STATUS_KEY, text);
    ctx.ui.setWorkingMessage(text);
  };

  tick();
  const ticker = setInterval(tick, 1_000);
  ambientStatusCleanup = () => {
    clearInterval(ticker);
    ambientStatusCleanup = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWorkingMessage();
  };
}

function clearAmbientRateLimitStatus(): void {
  ambientStatusCleanup?.();
}

export function waitForRateLimit(
  waitMs: number,
  signal?: AbortSignal,
): Promise<"waited" | "skipped" | "aborted"> {
  if (waitMs <= 0) return Promise.resolve(signal?.aborted ? "aborted" : "waited");

  return new Promise((resolve) => {
    if (signal?.aborted) { resolve("aborted"); return; }

    const ctx = sharedCtx;
    const deadline = Date.now() + waitMs;
    let done = false;

    // Intercept Enter via Pi's terminal input hook — consumes the keypress
    // so Pi's TUI never sees it and doesn't submit an empty message.
    let unsubInput: (() => void) | undefined;
    try {
      unsubInput = ctx?.ui.onTerminalInput((data) => {
        if (!done && (data === "\r" || data === "\n")) {
          cleanup();
          resolve("skipped");
          return { consume: true };
        }
      });
    } catch { /* UI unavailable */ }

    const onAbort = () => { if (!done) { cleanup(); resolve("aborted"); } };
    signal?.addEventListener("abort", onAbort);

    const tick = () => {
      const text = statusText(waitMs, deadline, Boolean(unsubInput));
      ctx?.ui.setStatus(STATUS_KEY, text);
      ctx?.ui.setWorkingMessage(text);
    };

    tick();
    const ticker = setInterval(() => {
      if (Date.now() >= deadline) { cleanup(); resolve("waited"); return; }
      tick();
    }, 1_000);

    function cleanup() {
      done = true;
      clearInterval(ticker);
      signal?.removeEventListener("abort", onAbort);
      unsubInput?.();
      ctx?.ui.setStatus(STATUS_KEY, undefined);
      ctx?.ui.setWorkingMessage(); // restore default "Working..."
      clearAmbientRateLimitStatus();
    }
  });
}

// ─── Early 429 observer ──────────────────────────────────────────────────────

function isAnthropicFetch(args: Parameters<typeof fetch>): boolean {
  const input = args[0];
  const url =
    typeof input === "string" ? input :
    input instanceof URL ? input.href :
    input.url;

  try {
    const host = new URL(url).host.toLowerCase();
    return host === "api.anthropic.com" || host.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

function installFetchRateLimitObserver(): void {
  if (restoreFetch || typeof globalThis.fetch !== "function") return;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);

    if (activeAnthropicSubscriptionRequests > 0 && isAnthropicFetch(args)) {
      if (response.status === 429) {
        const waitMs = retryAfterHeaderMs(response.headers) ?? DEFAULT_RATE_LIMIT_WAIT_MS;
        showAmbientRateLimitStatus(waitMs);
      } else if (ambientStatusCleanup && response.ok) {
        clearAmbientRateLimitStatus();
      }
    }

    return response;
  }) as typeof fetch;

  restoreFetch = () => {
    globalThis.fetch = originalFetch as typeof fetch;
    restoreFetch = undefined;
  };
}

// ─── Rate-limit-retrying streamSimple wrapper ────────────────────────────────

type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

function freshMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Wrap a streamSimple with an indefinite rate-limit retry loop.
 *
 * Important: we forward the built-in provider's events unchanged once an
 * attempt is known to be non-rate-limited. That preserves tool-call streaming
 * exactly. Potential rate-limited attempts are buffered and discarded, so Pi
 * never sees them.
 */
export function streamWithRateLimitRetry(
  delegate: StreamSimpleFn,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  void (async () => {
    let committed = false;

    const flush = (buffer: AssistantMessageEvent[]) => {
      for (const event of buffer) output.push(event);
      committed = true;
    };

    while (true) {
      activeAnthropicSubscriptionRequests++;
      installFetchRateLimitObserver();
      const buffer: AssistantMessageEvent[] = [];
      let gotRateLimit = false;
      let waitMs = DEFAULT_RATE_LIMIT_WAIT_MS;

      try {
        try {
          const inner = delegate(model, context, options);
          for await (const event of inner) {
            if (!committed) {
              if (event.type === "error") {
                const errMsg = event.error.errorMessage ?? "";
                if (isRateLimitError(errMsg) && !options?.signal?.aborted) {
                  gotRateLimit = true;
                  waitMs = rateLimitWaitMs(errMsg);
                  break;
                }
                // Non-rate-limit error: ensure start came first, then forward error.
                if (buffer.length > 0) {
                  flush(buffer);
                } else {
                  output.push({ type: "start", partial: freshMessage(model) });
                  committed = true;
                }
                output.push(event);
                output.end();
                return;
              }

              if (event.type === "start") {
                buffer.push(event);
                continue;
              }

              // First non-start, non-error event means this attempt is real.
              if (buffer.length > 0) {
                flush(buffer);
              } else {
                output.push({ type: "start", partial: freshMessage(model) });
                committed = true;
              }
              output.push(event);
              if (event.type === "done") {
                output.end();
                return;
              }
              continue;
            }

            // Once committed, forward everything unchanged.
            output.push(event);
            if (event.type === "done" || event.type === "error") {
              output.end();
              return;
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (isRateLimitError(errMsg) && !options?.signal?.aborted) {
            gotRateLimit = true;
            waitMs = rateLimitWaitMs(errMsg);
          } else {
            if (!committed) {
              // Synthetic start+error so the stream protocol stays valid.
              output.push({ type: "start", partial: freshMessage(model) });
              committed = true;
            }
            const error = freshMessage(model);
            error.stopReason = options?.signal?.aborted ? "aborted" : "error";
            error.errorMessage = errMsg;
            output.push({
              type: "error",
              reason: error.stopReason as "error" | "aborted",
              error,
            });
            output.end();
            return;
          }
        }
      } finally {
        activeAnthropicSubscriptionRequests--;
        if (activeAnthropicSubscriptionRequests === 0) {
          clearAmbientRateLimitStatus();
          restoreFetch?.();
        }
      }

      if (!gotRateLimit) {
        if (!committed) {
          if (buffer.length > 0) {
            flush(buffer);
          } else {
            output.push({ type: "start", partial: freshMessage(model) });
            committed = true;
          }
        }
        const error = freshMessage(model);
        error.stopReason = "error";
        error.errorMessage = "Provider stream ended without a terminal event.";
        output.push({ type: "error", reason: "error", error });
        output.end();
        return;
      }

      const waitResult = await waitForRateLimit(waitMs, options?.signal);
      if (waitResult === "aborted") {
        if (!committed) {
          output.push({ type: "start", partial: freshMessage(model) });
          committed = true;
        }
        const error = freshMessage(model);
        error.stopReason = "aborted";
        error.errorMessage = "Request aborted during rate-limit wait.";
        output.push({ type: "error", reason: "aborted", error });
        output.end();
        return;
      }
      // waited/skipped -> retry
    }
  })();

  return output;
}

// ─── Extension entry point ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    sharedCtx = ctx;
    if (!isAnthropicSubscriptionModel(ctx)) return;
    if (ctx.model) oauthAnthropicModelIds.add(ctx.model.id);

    const sanitised = sanitiseSystemPrompt(event.systemPrompt);
    const withIdentity = sanitised
      ? `${CLAUDE_CODE_IDENTITY}\n\n${sanitised}`
      : CLAUDE_CODE_IDENTITY;
    return { systemPrompt: withIdentity };
  });

  // Capture the built-in BEFORE registering our override to avoid
  // infinite recursion (registerProvider replaces the global handler).
  const builtinStreamSimple = getApiProvider("anthropic-messages")?.streamSimple;
  if (!builtinStreamSimple) return;

  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: (model, context, options) => {
      if (!isAnthropicSubscriptionRequest(model, options)) {
        return builtinStreamSimple(model, context, options);
      }
      return streamWithRateLimitRetry(builtinStreamSimple, model, context, options);
    },
  });
}
