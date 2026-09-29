import { requestUrl } from "obsidian";
import { localChatEndpoint, parsePartnerReply, partnerMessages, type PartnerRequest, type PartnerSuggestions } from "../domain/brainstorm-partner";
import type { AgentSettings } from "../domain/types";

export type PartnerPost = (request: {
  url: string;
  method: string;
  contentType: string;
  headers: Record<string, string>;
  body: string;
  throw: boolean;
}) => Promise<{ status: number; text: string }>;

/** Keeps a thinking model from spending minutes on one turn of a five-minute session. */
const REPLY_TOKENS = 2_048;

/**
 * Asks the local model for more ideas and things to consider (see
 * `src/domain/brainstorm-partner.ts`). The key, if the server needs one, comes from the
 * Keychain for this request only.
 */
export async function askLocalPartner(
  settings: AgentSettings,
  key: () => Promise<string>,
  request: PartnerRequest,
  post: PartnerPost = requestUrl as unknown as PartnerPost,
): Promise<PartnerSuggestions> {
  const url = localChatEndpoint(settings.localModelUrl);
  const apiKey = await key();
  let response: { status: number; text: string };
  try {
    response = await post({
      url,
      method: "POST",
      contentType: "application/json",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: JSON.stringify({
        ...(settings.localModel ? { model: settings.localModel } : {}),
        messages: partnerMessages(request),
        temperature: 0.9,
        max_tokens: Math.min(REPLY_TOKENS, settings.localMaxReplyTokens || REPLY_TOKENS),
      }),
      throw: false,
    });
  } catch {
    throw new Error("The local model server isn't reachable. Is LM Studio running with its server on?");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The local model server answered ${response.status}.`);
  }
  let content = "";
  try {
    const body = JSON.parse(response.text) as { choices?: Array<{ message?: { content?: unknown } }> };
    const value = body.choices?.[0]?.message?.content;
    content = typeof value === "string" ? value : "";
  } catch {
    throw new Error("The local model server's answer couldn't be read.");
  }
  return parsePartnerReply(content, request);
}
