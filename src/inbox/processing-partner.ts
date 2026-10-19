import { askChatModel, localTarget, openAiTarget, type ChatPost } from "../ai/chat-model";
import { parseProcessingReply, processingMessages, type ProcessingAdvice, type ProcessingRequest } from "../domain/processing-partner";
import type { AgentSettings, ProcessingPartnerSettings } from "../domain/types";

/** Room for a thinking model's reasoning and the advice; the advice itself is short. */
const REPLY_TOKENS = 4_096;

export interface PartnerKeys {
  /** The local model server's key from the Keychain, or `""`. */
  local(): Promise<string>;
  /** The OpenAI key from this device's secret storage, or `""`. */
  openai(): string;
}

/**
 * Whether the partner can be asked here: the local server is on the Mac, so a phone
 * can't reach it; OpenAI needs a model and this device's key.
 */
export function processingPartnerAvailable(settings: ProcessingPartnerSettings, desktop: boolean, keys: Pick<PartnerKeys, "openai">): boolean {
  return settings.provider === "local" ? desktop : Boolean(settings.openaiModel && keys.openai());
}

/** Asks the chosen model about one Inbox Item (see `src/domain/processing-partner.ts`). */
export async function askProcessingPartner(
  settings: ProcessingPartnerSettings,
  agent: AgentSettings,
  keys: PartnerKeys,
  request: ProcessingRequest,
  post?: ChatPost,
): Promise<ProcessingAdvice> {
  const target = settings.provider === "local"
    ? localTarget(agent, await keys.local())
    : openAiTarget(settings.openaiModel, keys.openai());
  const reply = await askChatModel(target, processingMessages(request), { maxTokens: REPLY_TOKENS, temperature: 0.3 }, post);
  return parseProcessingReply(reply, request);
}
