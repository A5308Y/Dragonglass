import { requestUrl } from "obsidian";
import { localChatEndpoint, type ChatMessage } from "../domain/brainstorm-partner";
import type { AgentSettings } from "../domain/types";

export type ChatPost = (request: {
  url: string;
  method: string;
  contentType: string;
  headers: Record<string, string>;
  body: string;
  throw: boolean;
}) => Promise<{ status: number; text: string }>;

/** A chat model the partners can ask: the local model server on this Mac, or OpenAI. */
export type ChatTarget =
  | { kind: "local"; url: string; model: string; key: string; maxTokens: number }
  | { kind: "openai"; model: string; key: string };

export const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";

/** The local model server the agent settings name, as this Mac reaches it. */
export function localTarget(settings: AgentSettings, key: string): ChatTarget {
  return {
    kind: "local",
    url: localChatEndpoint(settings.localModelUrl),
    model: settings.localModel,
    key,
    maxTokens: settings.localMaxReplyTokens,
  };
}

export function openAiTarget(model: string, key: string): ChatTarget {
  if (!model.trim()) throw new Error("No OpenAI model is set for the processing partner, nor for Codex runs.");
  if (!key) throw new Error("No OpenAI API key is set on this device.");
  return { kind: "openai", model: model.trim(), key };
}

/**
 * Sends one chat turn and returns the reply's text. Asks for JSON where the server
 * supports it; the callers read the reply leniently either way.
 */
export async function askChatModel(
  target: ChatTarget,
  messages: ChatMessage[],
  options: { maxTokens: number; temperature?: number },
  post: ChatPost = requestUrl as unknown as ChatPost,
): Promise<string> {
  const name = target.kind === "local" ? "The local model server" : "OpenAI";
  const body = target.kind === "local"
    ? {
      ...(target.model ? { model: target.model } : {}),
      messages,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      max_tokens: Math.min(options.maxTokens, target.maxTokens || options.maxTokens),
    }
    // Reasoning models refuse any temperature but the default, so none is sent.
    : { model: target.model, messages, response_format: { type: "json_object" }, max_completion_tokens: options.maxTokens };
  let response: { status: number; text: string };
  try {
    response = await post({
      url: target.kind === "local" ? target.url : OPENAI_CHAT_ENDPOINT,
      method: "POST",
      contentType: "application/json",
      headers: target.key ? { Authorization: `Bearer ${target.key}` } : {},
      body: JSON.stringify(body),
      throw: false,
    });
  } catch {
    throw new Error(target.kind === "local"
      ? "The local model server isn't reachable. Is LM Studio running with its server on?"
      : "OpenAI isn't reachable. Is this device online?");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${name} answered ${response.status}${response.status === 401 ? ": the API key was refused" : ""}.`);
  }
  try {
    const parsed = JSON.parse(response.text) as { choices?: Array<{ message?: { content?: unknown } }> };
    const value = parsed.choices?.[0]?.message?.content;
    return typeof value === "string" ? value : "";
  } catch {
    throw new Error(`${name}'s answer couldn't be read.`);
  }
}
