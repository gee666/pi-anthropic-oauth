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

const RATE_LIMIT_WAIT_MS = 30 * 60 * 1_000; // 30 minutes

/** Key used with ctx.ui.setStatus() for the countdown line. */
const STATUS_KEY = "rate-limit";

// ─── Shared UI context ────────────────────────────────────────────────────────

let sharedCtx: ExtensionContext | undefined;

// ─── Prompt sanitisation ──────────────────────────────────────────────────────

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

// ─── 429 detection ───────────────────────────────────────────────────────────
// Match only the HTTP 429 status code — deliberately not matching the phrase
// "rate limit" so we don't accidentally swallow unrelated errors.

function is429(msg: string): boolean {
  return msg.includes("429");
}

// ─── Rate-limit countdown ─────────────────────────────────────────────────────

function waitForRateLimit(
  waitMs: number,
  signal?: AbortSignal,
): Promise<"waited" | "skipped" | "aborted"> {
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
      const remaining = Math.max(0, deadline - Date.now());
      const totalSecs = Math.ceil(remaining / 1_000);
      const mins = Math.floor(totalSecs / 60);
      const secs = (totalSecs % 60).toString().padStart(2, "0");
      const text =
        `⏳ Rate limited — next retry in ${mins}m ${secs}s` +
        (unsubInput ? "  (Enter to retry now)" : "");
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
    }
  });
}

// ─── 429-retrying streamSimple wrapper ───────────────────────────────────────

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
 * Wrap a streamSimple with an indefinite 429 retry loop.
 *
 * Important: we forward the built-in provider's events unchanged once an
 * attempt is known to be non-429. That preserves tool-call streaming exactly.
 * Potential 429 attempts are buffered and discarded, so Pi never sees them.
 */
function streamWithRateLimitRetry(
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
      const inner = delegate(model, context, options);
      const buffer: AssistantMessageEvent[] = [];
      let got429 = false;

      try {
        for await (const event of inner) {
          if (!committed) {
            if (event.type === "error") {
              const errMsg = event.error.errorMessage ?? "";
              if (is429(errMsg) && !options?.signal?.aborted) {
                got429 = true;
                break;
              }
              // Non-429 error: flush buffered start (if any), then forward error.
              flush(buffer);
              output.push(event);
              output.end();
              return;
            }

            if (event.type === "start") {
              buffer.push(event);
              continue;
            }

            // First non-start, non-error event means this attempt is real.
            flush(buffer);
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
        if (is429(errMsg) && !options?.signal?.aborted) {
          got429 = true;
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

      if (!got429) {
        // If a successful attempt ended with only start+done, flush buffered events.
        if (!committed && buffer.length > 0) {
          flush(buffer);
        }
        output.end();
        return;
      }

      const waitResult = await waitForRateLimit(RATE_LIMIT_WAIT_MS, options?.signal);
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
    streamSimple: (model, context, options) =>
      streamWithRateLimitRetry(builtinStreamSimple, model, context, options),
  });
}
