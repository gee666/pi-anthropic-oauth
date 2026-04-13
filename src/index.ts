import { existsSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@mariozechner/pi-coding-agent";
import { getModels, type OAuthCredentials } from "@mariozechner/pi-ai";
import { loginAnthropic, refreshAnthropicToken } from "./auth.js";
import { streamAnthropicOAuth } from "./stream.js";

// IDs of the models available under a Claude Pro/Max subscription.
// const SUBSCRIPTION_MODEL_IDS = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];

// Pull model definitions (contextWindow, maxTokens, reasoning, etc.) from
// @mariozechner/pi-ai's generated model registry so they stay in sync
// automatically when pi-ai is updated, rather than being hardcoded here.
// We pick only the fields needed by ProviderModelConfig, stripping extra
// fields like `api`, `provider`, and `baseUrl` that come from the registry.
const MODELS = getModels("anthropic")
//  .filter((m) => SUBSCRIPTION_MODEL_IDS.includes(m.id))
  .map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input as ("text" | "image")[],
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));

function ensureClaudeCodeSymlink() {
  const target = join(homedir(), ".pi");
  const link = join(homedir(), ".Claude Code");
  if (existsSync(target) && !existsSync(link)) {
    try {
      symlinkSync(target, link);
    } catch {}
  }
}

export default function (pi: ExtensionAPI) {
  ensureClaudeCodeSymlink();

  pi.registerProvider("anthropic", {
    baseUrl: "https://api.anthropic.com",
    apiKey: "ANTHROPIC_MAX_API_KEY",
    api: "anthropic-max-api",
    models: [...MODELS],
    oauth: {
      name: "Claude Pro/Max",
      usesCallbackServer: true,
      login: loginAnthropic,
      refreshToken: refreshAnthropicToken,
      getApiKey: (credentials: OAuthCredentials) => credentials.access,
    } as unknown as ProviderConfig["oauth"],
    streamSimple: streamAnthropicOAuth,
  });
}
