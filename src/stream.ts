import Anthropic, { RateLimitError } from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import * as readline from "node:readline";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
} from "@mariozechner/pi-ai";
import { USER_AGENT, isClaudeOAuthAccessToken } from "./auth.js";
import {
  convertPiMessagesToAnthropic,
  convertPiToolsToAnthropic,
  fromClaudeCodeToolName,
  type IndexedBlock,
} from "./convert.js";
import { buildAnthropicSystemPrompt } from "./prompt.js";

const REQUIRED_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
] as const;

/** Wait 30 minutes before retrying after a 429 rate-limit response. */
const RATE_LIMIT_WAIT_MS = 30 * 60 * 1000;
const RATE_LIMIT_COUNTDOWN_INTERVAL_MS = 1_000;

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "error";
  }
}

function makeDefaultHeaders(
  isOAuth: boolean,
  options?: SimpleStreamOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
  };

  if (isOAuth) {
    headers["anthropic-beta"] = REQUIRED_BETAS.join(",");
    headers["user-agent"] = USER_AGENT;
    headers["x-app"] = "cli";
  } else {
    headers["anthropic-beta"] = [
      "fine-grained-tool-streaming-2025-05-14",
      "interleaved-thinking-2025-05-14",
    ].join(",");
  }

  if (options?.headers) {
    for (const [key, value] of Object.entries(options.headers))
      headers[key] = value;
  }

  return headers;
}

/**
 * Shows a countdown on stderr and waits for the rate-limit window to expire.
 *
 * The wait can be skipped early in two ways:
 *   - The caller's AbortSignal fires  (user quits / Ctrl+C)
 *   - A line is typed on stdin         (treated as the Ctrl+429 / "retry now" shortcut)
 *
 * Returns "waited" | "skipped" | "aborted".
 */
function waitForRateLimit(
  waitMs: number,
  signal?: AbortSignal,
): Promise<"waited" | "skipped" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve("aborted");
      return;
    }

    const deadline = Date.now() + waitMs;
    let done = false;

    // ---- stdin listener (Enter = retry now) --------------------------------
    // We try to attach a one-shot readline listener so the user can press
    // Enter to skip the countdown.  This may silently fail if the host
    // application already owns stdin (e.g. a TUI framework); that is fine —
    // we degrade gracefully to countdown-only mode.
    let rl: readline.Interface | undefined;
    try {
      rl = readline.createInterface({
        input: process.stdin,
        // Don't write a prompt — we are only listening, not prompting.
        terminal: false,
      });
      rl.once("line", () => {
        if (!done) { cleanup(); resolve("skipped"); }
      });
    } catch {
      // stdin unavailable or readline failed — countdown-only mode
    }

    // ---- abort listener ----------------------------------------------------
    const onAbort = () => { if (!done) { cleanup(); resolve("aborted"); } };
    signal?.addEventListener("abort", onAbort);

    // ---- countdown ticker --------------------------------------------------
    const writeLine = () => {
      const remaining = Math.max(0, deadline - Date.now());
      const totalSecs = Math.ceil(remaining / 1_000);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      // \r overwrites the current line so we don't spam the terminal.
      process.stderr.write(
        `\r⏳ Rate limited. Next retry in ${mins}m ${secs.toString().padStart(2, "0")}s  — press Enter to retry now, Ctrl+C to quit...`
      );
    };

    writeLine();
    const ticker = setInterval(() => {
      if (Date.now() >= deadline) {
        cleanup();
        resolve("waited");
        return;
      }
      writeLine();
    }, RATE_LIMIT_COUNTDOWN_INTERVAL_MS);

    function cleanup() {
      done = true;
      clearInterval(ticker);
      signal?.removeEventListener("abort", onAbort);
      try {
        rl?.close();
        // Re-pause stdin so we don't disturb the host app's input handling.
        process.stdin.pause();
      } catch {}
      // Erase the countdown line from the terminal.
      process.stderr.write("\r" + " ".repeat(80) + "\r");
    }
  });
}

/** Fresh zero-cost usage record for resetting between retries. */
function freshUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function streamAnthropicOAuth(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: freshUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // Track whether we have already pushed the "start" event so that we do
    // not emit it a second time after retrying a rate-limited request.
    let started = false;

    // ── Retry loop ──────────────────────────────────────────────────────────
    // On a 429 we wait RATE_LIMIT_WAIT_MS, then loop back and try again.
    // Any other error (including abort) breaks out immediately.
    while (true) {
      try {
        const apiKey = options?.apiKey ?? "";
        const isOAuth = isClaudeOAuthAccessToken(apiKey);
        const defaultHeaders = makeDefaultHeaders(isOAuth, options);

        if (isOAuth) {
          // Set the bearer token via defaultHeaders only.
          // Do NOT pass authToken to the SDK constructor — doing so would cause
          // the SDK to emit a duplicate Authorization header.
          // Do NOT pass apiKey as undefined — the SDK would then fall back to
          // process.env.ANTHROPIC_API_KEY and send an x-api-key header
          // alongside the OAuth bearer token, causing a 401 after long sessions.
          // We pass a dummy non-empty apiKey to suppress the env-var fallback,
          // then explicitly blank x-api-key in defaultHeaders so the SDK's own
          // apiKeyAuth() header (which fires whenever apiKey != null) is erased.
          defaultHeaders["authorization"] = `Bearer ${apiKey}`;
          defaultHeaders["x-api-key"] = ""; // suppress SDK's apiKeyAuth() header
        }

        const client = new Anthropic({
          baseURL: model.baseUrl,
          // Dummy non-empty value: prevents env-var fallback (apiKey=undefined
          // would read ANTHROPIC_API_KEY from the environment).
          // The real auth is the Bearer token in defaultHeaders above.
          apiKey: isOAuth ? "oauth-via-header" : apiKey,
          // authToken intentionally NOT set for OAuth (see above).
          defaultHeaders,
          dangerouslyAllowBrowser: true,
          // Disable SDK-level retries so that 429s surface to our own loop
          // immediately rather than burning the SDK's built-in retry budget.
          maxRetries: 0,
        });

        const maxTokens =
          options?.maxTokens ?? Math.floor(model.maxTokens / 3);

        const params: MessageCreateParamsStreaming = {
          model: model.id,
          messages: convertPiMessagesToAnthropic(context.messages, isOAuth),
          max_tokens: maxTokens,
          stream: true,
        };

        const system = buildAnthropicSystemPrompt(context.systemPrompt, isOAuth);
        if (system) params.system = system as never;
        if (context.tools?.length)
          params.tools = convertPiToolsToAnthropic(context.tools, isOAuth);

        if (options?.reasoning && model.reasoning && maxTokens > 1) {
          const defaultBudgets: Record<string, number> = {
            minimal: 1024,
            low: 4096,
            medium: 10240,
            high: 20480,
            xhigh: 32000,
          };
          const customBudget =
            options.thinkingBudgets?.[
              options.reasoning as keyof typeof options.thinkingBudgets
            ];
          const requestedBudget =
            customBudget ?? defaultBudgets[options.reasoning] ?? 10240;

          params.thinking = {
            type: "enabled",
            budget_tokens: Math.min(requestedBudget, maxTokens - 1),
          };
        }

        const anthropicStream = client.messages.stream(params, {
          signal: options?.signal,
        });

        if (!started) {
          stream.push({ type: "start", partial: output });
          started = true;
        }

        const blocks = output.content as IndexedBlock[];

        for await (const event of anthropicStream) {
          if (event.type === "message_start") {
            output.usage.input = event.message.usage.input_tokens || 0;
            output.usage.output = event.message.usage.output_tokens || 0;
            output.usage.cacheRead =
              (event.message.usage as { cache_read_input_tokens?: number })
                .cache_read_input_tokens || 0;
            output.usage.cacheWrite =
              (event.message.usage as { cache_creation_input_tokens?: number })
                .cache_creation_input_tokens || 0;
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
            continue;
          }

          if (event.type === "content_block_start") {
            if (event.content_block.type === "text") {
              output.content.push({
                type: "text",
                text: "",
                index: event.index,
              } as IndexedBlock);
              stream.push({
                type: "text_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            } else if (event.content_block.type === "thinking") {
              output.content.push({
                type: "thinking",
                thinking: "",
                thinkingSignature: "",
                index: event.index,
              } as IndexedBlock);
              stream.push({
                type: "thinking_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            } else if (event.content_block.type === "tool_use") {
              output.content.push({
                type: "toolCall",
                id: event.content_block.id,
                name: isOAuth
                  ? fromClaudeCodeToolName(
                      event.content_block.name,
                      context.tools,
                    )
                  : event.content_block.name,
                arguments: {},
                partialJson: "",
                index: event.index,
              } as IndexedBlock);
              stream.push({
                type: "toolcall_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }
            continue;
          }

          if (event.type === "content_block_delta") {
            const contentIndex = blocks.findIndex(
              (block) => block.index === event.index,
            );
            const block = blocks[contentIndex];
            if (!block) continue;

            if (event.delta.type === "text_delta" && block.type === "text") {
              block.text += event.delta.text;
              stream.push({
                type: "text_delta",
                contentIndex,
                delta: event.delta.text,
                partial: output,
              });
            } else if (
              event.delta.type === "thinking_delta" &&
              block.type === "thinking"
            ) {
              block.thinking += event.delta.thinking;
              stream.push({
                type: "thinking_delta",
                contentIndex,
                delta: event.delta.thinking,
                partial: output,
              });
            } else if (
              event.delta.type === "signature_delta" &&
              block.type === "thinking"
            ) {
              block.thinkingSignature =
                (block.thinkingSignature || "") + event.delta.signature;
            } else if (
              event.delta.type === "input_json_delta" &&
              block.type === "toolCall"
            ) {
              block.partialJson += event.delta.partial_json;
              try {
                block.arguments = JSON.parse(block.partialJson) as Record<
                  string,
                  unknown
                >;
              } catch {}
              stream.push({
                type: "toolcall_delta",
                contentIndex,
                delta: event.delta.partial_json,
                partial: output,
              });
            }
            continue;
          }

          if (event.type === "content_block_stop") {
            const contentIndex = blocks.findIndex(
              (block) => block.index === event.index,
            );
            const block = blocks[contentIndex];
            if (!block) continue;

            delete (block as { index?: number }).index;
            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex,
                content: block.text,
                partial: output,
              });
            } else if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex,
                content: block.thinking,
                partial: output,
              });
            } else if (block.type === "toolCall") {
              try {
                block.arguments = JSON.parse(block.partialJson) as Record<
                  string,
                  unknown
                >;
              } catch {}
              delete (block as { partialJson?: string }).partialJson;
              stream.push({
                type: "toolcall_end",
                contentIndex,
                toolCall: block,
                partial: output,
              });
            }
            continue;
          }

          if (event.type === "message_delta") {
            output.stopReason = mapStopReason(event.delta.stop_reason);
            output.usage.input =
              (event.usage as { input_tokens?: number }).input_tokens ||
              output.usage.input;
            output.usage.output =
              (event.usage as { output_tokens?: number }).output_tokens ||
              output.usage.output;
            output.usage.cacheRead =
              (event.usage as { cache_read_input_tokens?: number })
                .cache_read_input_tokens || 0;
            output.usage.cacheWrite =
              (event.usage as { cache_creation_input_tokens?: number })
                .cache_creation_input_tokens || 0;
            output.usage.totalTokens =
              output.usage.input +
              output.usage.output +
              output.usage.cacheRead +
              output.usage.cacheWrite;
            calculateCost(model, output.usage);
          }
        }

        // ── Success ─────────────────────────────────────────────────────────
        if (options?.signal?.aborted) throw new Error("Request aborted");
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        stream.end();
        return; // exit the retry loop

      } catch (error) {
        // ── 429 Rate Limit ──────────────────────────────────────────────────
        if (error instanceof RateLimitError && !options?.signal?.aborted) {
          // Reset any partial content so the next attempt starts clean.
          // Splice in-place rather than replacing the array, so any framework
          // code that captured a reference to output.content still sees a
          // consistent (empty) array after the reset.
          (output.content as unknown[]).splice(0);
          output.usage = freshUsage();
          output.stopReason = "stop";

          process.stderr.write(
            "\n⚠️  Claude API rate limit reached. Will retry after 30 minutes.\n"
          );

          const waitResult = await waitForRateLimit(
            RATE_LIMIT_WAIT_MS,
            options?.signal,
          );

          if (waitResult === "aborted") {
            // User quit during the wait — surface as an aborted error.
            output.stopReason = "aborted";
            output.errorMessage = "Request aborted during rate-limit wait.";
            if (!started) {
              stream.push({ type: "start", partial: output });
            }
            stream.push({ type: "error", reason: "aborted", error: output });
            stream.end();
            return;
          }

          process.stderr.write("\u{1F504} Retrying request...\n");
          // "waited" or "skipped" → fall through and loop back
          continue;
        }

        // ── All other errors ────────────────────────────────────────────────
        for (const block of output.content as Array<{
          index?: number;
          partialJson?: string;
        }>) {
          delete block.index;
          delete block.partialJson;
        }
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage =
          error instanceof Error ? error.message : String(error);
        if (!started) {
          stream.push({ type: "start", partial: output });
        }
        stream.push({ type: "error", reason: output.stopReason as "error" | "aborted", error: output });
        stream.end();
        return;
      }
    }
  })();

  return stream;
}
