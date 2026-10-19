import { askChatModel, localTarget, openAiTarget, type ChatPost } from "../ai/chat-model";
import {
  PROCESSING_SCHEMA,
  parseProcessingReply,
  processingMessages,
  processingPrompt,
  type ProcessingAdvice,
  type ProcessingRequest,
} from "../domain/processing-partner";
import type { AgentSettings, ProcessingPartnerSettings } from "../domain/types";

/** Room for a thinking model's reasoning and the advice; the advice itself is short. */
const REPLY_TOKENS = 4_096;

export interface PartnerKeys {
  /** The local model server's key from the Keychain, or `""`. */
  local(): Promise<string>;
  /** The OpenAI key from this device's secret storage, or `""`. */
  openai(): string;
}

/** Codex on the ChatGPT plan, in its container: `AgentService.askCodex`. */
export type AskCodex = (prompt: string, schema: object) => Promise<string>;

/** The OpenAI model the partner asks: its own setting, or else the one Codex runs use. */
export function partnerOpenAiModel(settings: ProcessingPartnerSettings, agent: AgentSettings): string {
  return settings.openaiModel.trim() || agent.codexModel.trim();
}

/**
 * Whether the partner can be asked here: the local server and Codex's container are on
 * the Mac, so a phone can't reach them; OpenAI needs a model and this device's key.
 * Codex's sign-in is checked when it is asked, and its absence said in the panel.
 */
export function processingPartnerAvailable(
  settings: ProcessingPartnerSettings,
  agent: AgentSettings,
  desktop: boolean,
  keys: Pick<PartnerKeys, "openai">,
): boolean {
  return settings.provider === "openai" ? Boolean(partnerOpenAiModel(settings, agent) && keys.openai()) : desktop;
}

/** Asks the chosen model about one Inbox Item (see `src/domain/processing-partner.ts`). */
export async function askProcessingPartner(
  settings: ProcessingPartnerSettings,
  agent: AgentSettings,
  keys: PartnerKeys,
  request: ProcessingRequest,
  askCodex: AskCodex,
  post?: ChatPost,
): Promise<ProcessingAdvice> {
  if (settings.provider === "codex") return parseProcessingReply(await askCodex(processingPrompt(request), PROCESSING_SCHEMA), request);
  const target = settings.provider === "local"
    ? localTarget(agent, await keys.local())
    : openAiTarget(partnerOpenAiModel(settings, agent), keys.openai());
  const reply = await askChatModel(target, processingMessages(request), { maxTokens: REPLY_TOKENS, temperature: 0.3 }, post);
  return parseProcessingReply(reply, request);
}
