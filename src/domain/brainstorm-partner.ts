/**
 * A brainstorming partner: the local model the agent settings name, asked every so
 * often during a Brainstorm session for new ideas and for perspectives to consider.
 *
 * It is not a delegated agent run. Those work on copies of a Project in a container for
 * minutes; a partner has to answer within a pause in typing, so the plugin asks the model
 * server directly. It sends only the session's topic, desired outcome and ideas, and only
 * to a server on this Mac: the rule for local runs ("the more it sees, the less it can
 * reach") holds because it sees little and reaches nothing else.
 */

export interface PartnerRequest {
  topic: string;
  desiredOutcome: string;
  /** What has been written so far. */
  ideas: string;
  /** What the partner has already offered this session, so it doesn't repeat itself. */
  offered: string[];
}

export interface PartnerSuggestions {
  ideas: string[];
  /** Angles, questions, risks and assumptions worth a thought. */
  considerations: string[];
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const SYSTEM = [
  "You are a brainstorming partner in a five-minute brainstorm. The person writes ideas; you add to them.",
  "Stay divergent: no judging, no ranking, no plans. Build on what is written, but don't repeat it.",
  "Offer 3 new ideas, each a single short line, and 2 things to consider: a different perspective, a question,",
  "an assumption to test, someone affected, or a risk.",
  "Write in the language the person writes in.",
  'Answer with JSON only: {"ideas": ["…"], "considerations": ["…"]}',
].join(" ");

/** The longest text taken from each field, so a long session still fits a small context. */
const FIELD_LIMIT = 6_000;

export function partnerMessages(request: PartnerRequest): ChatMessage[] {
  const lines = [
    `Topic: ${clip(request.topic)}`,
    request.desiredOutcome.trim() ? `Desired outcome: ${clip(request.desiredOutcome)}` : "",
    "",
    "Ideas so far:",
    request.ideas.trim() ? clip(request.ideas) : "(nothing yet)",
    ...(request.offered.length ? ["", "You already suggested, so don't repeat:", ...request.offered.map((line) => `- ${line}`)] : []),
  ];
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: lines.filter((line, index) => line || index > 1).join("\n").trim() },
  ];
}

/**
 * Reads the model's answer: the JSON it was asked for, found even when a model thinks
 * aloud first or wraps it in a code fence; failing that, its list lines as ideas.
 * Suggestions already offered or already written are dropped.
 */
export function parsePartnerReply(text: string, request: Pick<PartnerRequest, "ideas" | "offered">): PartnerSuggestions {
  const answer = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const parsed = jsonObject(answer);
  const suggestions = parsed
    ? { ideas: strings(parsed.ideas), considerations: strings(parsed.considerations) }
    : { ideas: listLines(answer), considerations: [] };
  const known = new Set([...request.offered, ...request.ideas.split("\n")].map(normalise).filter(Boolean));
  const fresh = (items: string[]) => {
    const kept: string[] = [];
    for (const item of items) {
      const key = normalise(item);
      if (!key || known.has(key)) continue;
      known.add(key);
      kept.push(item);
    }
    return kept;
  };
  return { ideas: fresh(suggestions.ideas).slice(0, 5), considerations: fresh(suggestions.considerations).slice(0, 3) };
}

/**
 * The chat endpoint of the local model server, as this Mac reaches it. The setting is
 * written as the containers see the Mac (`host.docker.internal`), which here is
 * `127.0.0.1`. Any other host is refused: the partner is local or it isn't used.
 */
export function localChatEndpoint(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl.trim());
  } catch {
    throw new Error("The local model server address in the agent settings isn't a valid address.");
  }
  if (url.hostname === "host.docker.internal") url.hostname = "127.0.0.1";
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("The brainstorm partner only talks to a model server on this Mac; the agent settings name another host.");
  }
  const base = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.protocol}//${url.host}${base}/v1/chat/completions`;
}

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map(tidy).filter(Boolean) : [];
}

function listLines(text: string): string[] {
  return text.split("\n").filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).map((line) => tidy(line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")));
}

/** One line, without list markers or surrounding quotes, and not endless. */
function tidy(item: string): string {
  const line = item.replace(/\s+/g, " ").trim().replace(/^["“]|["”]$/g, "").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function normalise(item: string): string {
  return item.toLowerCase().replace(/^[-*•\s]+/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > FIELD_LIMIT ? `…${trimmed.slice(-FIELD_LIMIT)}` : trimmed;
}
