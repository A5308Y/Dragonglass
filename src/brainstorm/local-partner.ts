import { askChatModel, localTarget, type ChatPost } from "../ai/chat-model";
import { parsePartnerReply, partnerMessages, type PartnerRequest, type PartnerSuggestions } from "../domain/brainstorm-partner";
import type { AgentSettings } from "../domain/types";

export type PartnerPost = ChatPost;

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
  post?: PartnerPost,
): Promise<PartnerSuggestions> {
  const target = localTarget(settings, await key());
  const content = await askChatModel(target, partnerMessages(request), { maxTokens: REPLY_TOKENS, temperature: 0.9 }, post);
  return parsePartnerReply(content, request);
}
