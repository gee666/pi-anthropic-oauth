import type { ContentBlockParam, MessageParam, ToolUnion } from "@anthropic-ai/sdk/resources/messages.js";

type ToolResultContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    };
import type {
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { sanitizeSurrogates } from "./prompt.js";

export type IndexedBlock =
  | (TextContent & { index: number })
  | (ThinkingContent & { index: number; thinkingSignature?: string })
  | (ToolCall & { index: number; partialJson: string });

const claudeCodeTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
] as const;
const claudeCodeToolLookup = new Map(claudeCodeTools.map((name) => [name.toLowerCase(), name]));

export function toClaudeCodeToolName(name: string): string {
  return claudeCodeToolLookup.get(name.toLowerCase()) ?? name;
}

export function fromClaudeCodeToolName(name: string, tools?: Tool[]): string {
  const lower = name.toLowerCase();
  return tools?.find((tool) => tool.name.toLowerCase() === lower)?.name ?? name;
}

export function convertPiMessagesToAnthropic(
  messages: Message[],
  isOAuth: boolean,
): MessageParam[] {
  const params: MessageParam[] = [];
  const toolIdMap = new Map<string, string>();
  const usedToolIds = new Set<string>();

  const getAnthropicToolId = (id: string): string => {
    const existing = toolIdMap.get(id);
    if (existing) return existing;

    let base = sanitizeSurrogates(id).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!base) base = "tool";
    let candidate = base;
    let suffix = 1;
    while (usedToolIds.has(candidate)) {
      candidate = `${base}_${suffix++}`;
    }
    usedToolIds.add(candidate);
    toolIdMap.set(id, candidate);
    return candidate;
  };

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    if (message.role === "user") {
      if (typeof message.content === "string") {
        if (message.content.trim()) params.push({ role: "user", content: sanitizeSurrogates(message.content) });
      } else {
        const blocks: ContentBlockParam[] = message.content.map((item) =>
          item.type === "text"
            ? { type: "text", text: sanitizeSurrogates(item.text) }
            : {
                type: "image",
                source: { type: "base64", media_type: item.mimeType as never, data: item.data },
              },
        );
        if (blocks.length > 0) params.push({ role: "user", content: blocks });
      }
      continue;
    }

    if (message.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
        } else if (block.type === "thinking" && block.thinking.trim()) {
          if (block.thinkingSignature) {
            blocks.push({
              type: "thinking" as never,
              thinking: sanitizeSurrogates(block.thinking),
              signature: block.thinkingSignature,
            });
          } else {
            blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: getAnthropicToolId(block.id),
            name: isOAuth ? toClaudeCodeToolName(block.name) : block.name,
            input: block.arguments,
          });
        }
      }
      if (blocks.length > 0) params.push({ role: "assistant", content: blocks });
      continue;
    }

    if (message.role === "toolResult") {
      const toolResults = [
        {
          type: "tool_result" as const,
          tool_use_id: getAnthropicToolId(message.toolCallId),
          content: convertToolResultContentToAnthropic(message.content),
          is_error: message.isError,
        },
      ];

      let j = i + 1;
      while (j < messages.length && messages[j]?.role === "toolResult") {
        const nextMessage = messages[j] as ToolResultMessage;
        toolResults.push({
          type: "tool_result" as const,
          tool_use_id: getAnthropicToolId(nextMessage.toolCallId),
          content: convertToolResultContentToAnthropic(nextMessage.content),
          is_error: nextMessage.isError,
        });
        j++;
      }
      i = j - 1;
      params.push({ role: "user", content: toolResults });
    }
  }

  const last = params.at(-1);
  if (last?.role === "user" && Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1] as { cache_control?: { type: string } };
    lastBlock.cache_control = { type: "ephemeral" };
  }

  return params;
}

export function convertPiToolsToAnthropic(tools: Tool[], isOAuth: boolean): ToolUnion[] {
  return tools.map((tool) => ({
    name: isOAuth ? toClaudeCodeToolName(tool.name) : tool.name,
    description: tool.description,
    input_schema: {
      type: "object" as const,
      properties: (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {},
      required: (tool.parameters as { required?: string[] }).required ?? [],
    },
  }));
}

function convertToolResultContentToAnthropic(
  content: (TextContent | ImageContent)[],
): string | ToolResultContentBlock[] {
  const hasImages = content.some((block) => block.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(
      content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );
  }

  const blocks = content.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: sanitizeSurrogates(block.text) };
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: block.mimeType as ToolResultContentBlock extends { type: "image"; source: infer S }
          ? S extends { media_type: infer M }
            ? M
            : never
          : never,
        data: block.data,
      },
    };
  });

  if (!blocks.some((block) => block.type === "text")) {
    blocks.unshift({ type: "text", text: "(see attached image)" });
  }

  return blocks;
}
