import { describe, expect, it } from "vitest";
import { parseProcessingReply, processingMessages, type ProcessingRequest } from "../src/domain/processing-partner";
import { askProcessingPartner, processingPartnerAvailable } from "../src/inbox/processing-partner";
import type { ChatPost } from "../src/ai/chat-model";
import { defaultSettings } from "../src/state/defaults";

const request: ProcessingRequest = {
  item: { title: "Contract from Acme", body: "Please review the attached contract by Friday.", kind: "mail" },
  form: { project: "Acme onboarding", projectIsNew: true, vision: "", action: "Open the contract", status: "next", context: "" },
  projects: [
    { name: "Clients > Acme", status: "active" },
    { name: "Clients > Beta > Website", status: "someday" },
    { name: "Home > Website", status: "active" },
  ],
  contexts: ["@Computer", "Phone"],
};

describe("The processing partner's question", () => {
  it("sends the Item, the form, the Projects and the contexts, and nothing else", () => {
    const [system, user] = processingMessages(request);
    expect(system?.content).toContain("JSON only");
    expect(system?.content).toContain("is not progress");
    expect(user?.content).toBe([
      "Inbox item (an email): Contract from Acme",
      "",
      "Please review the attached contract by Friday.",
      "",
      "The form so far:",
      "Project (new): Acme onboarding",
      "Project vision: (empty)",
      "Action: Open the contract",
      "Action status: next",
      "Context: (empty)",
      "",
      "Projects:",
      "- Clients > Acme",
      "- Clients > Beta > Website (someday)",
      "- Home > Website",
      "",
      "Contexts: @Computer, Phone",
    ].join("\n"));
  });
});

describe("Reading the partner's advice", () => {
  const reply = (value: unknown) => `<think>Hmm.</think>\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

  it("matches Projects and contexts to their names here, and keeps a new Project's outcome", () => {
    const advice = parseProcessingReply(reply({
      actionable: "yes",
      nonActionable: "null",
      summary: "A contract to review for Acme.",
      suggestions: [
        { action: "Mark the clauses to renegotiate", project: "clients > acme", newProject: true, desiredOutcome: "ignored", context: "computer", why: "Produces the list." },
        { action: "Draft a reply", project: "Acme legal", newProject: false, desiredOutcome: "Contract signed", context: null, why: "" },
        { action: "Fix the site", project: "Website", context: "Errands", why: "" },
        { action: "", project: "Clients > Acme" },
        "nonsense",
      ],
      check: { verdict: "no-progress", note: "Opening it changes nothing.", better: "Mark the three clauses to renegotiate" },
    }), request);
    expect(advice).toEqual({
      actionable: "yes",
      summary: "A contract to review for Acme.",
      suggestions: [
        { action: "Mark the clauses to renegotiate", project: "Clients > Acme", newProject: false, context: "@Computer", why: "Produces the list." },
        { action: "Draft a reply", project: "Acme legal", newProject: true, desiredOutcome: "Contract signed", why: "" },
        // Two Projects are called Website, so the title alone names neither.
        { action: "Fix the site", project: "Website", newProject: true, context: "Errands", why: "" },
      ],
      check: { verdict: "no-progress", note: "Opening it changes nothing.", better: "Mark the three clauses to renegotiate" },
    });
  });

  it("says where a non-actionable Item belongs", () => {
    expect(parseProcessingReply(reply({ actionable: "no", nonActionable: "Reference", summary: "Terms for later.", suggestions: [] }), request))
      .toEqual({ actionable: "no", nonActionable: "reference", summary: "Terms for later.", suggestions: [] });
  });

  it("drops a judgement it can't name, one of an empty Action, and a better wording that is the same", () => {
    expect(parseProcessingReply(reply({ actionable: "yes", check: { verdict: "excellent", note: "" } }), request).check).toBeUndefined();
    const empty = { ...request, form: { ...request.form, action: "" } };
    expect(parseProcessingReply(reply({ actionable: "yes", check: { verdict: "vague", note: "?" } }), empty).check).toBeUndefined();
    expect(parseProcessingReply(reply({ actionable: "yes", check: { verdict: "vague", note: "Which part?", better: "open the contract!" } }), request).check)
      .toEqual({ verdict: "vague", note: "Which part?" });
    expect(parseProcessingReply(reply({ actionable: "yes", check: { verdict: "good", note: "Fine.", better: "Something else" } }), request).check)
      .toEqual({ verdict: "good", note: "Fine." });
  });

  it("refuses an answer without JSON", () => {
    expect(() => parseProcessingReply("Sure! Here are some ideas.", request)).toThrow("couldn't be read");
  });
});

describe("Asking the processing partner", () => {
  const settings = defaultSettings();
  const answer = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });
  const advice = '{"actionable": "yes", "summary": "", "suggestions": [{"action": "Call Acme", "why": ""}]}';

  it("asks the local model server on this Mac", async () => {
    const sent: Parameters<ChatPost>[0][] = [];
    const post: ChatPost = async (sentRequest) => {
      sent.push(sentRequest);
      return { status: 200, text: answer(advice) };
    };
    const agent = { ...settings.agent, localModel: "qwen/qwen3", localModelUrl: "http://host.docker.internal:1234", localMaxReplyTokens: 1024 };
    const result = await askProcessingPartner(settings.processingPartner, agent, { local: async () => "", openai: () => "unused" }, request, post);
    expect(result.suggestions).toEqual([{ action: "Call Acme", newProject: false, why: "" }]);
    expect(sent[0]!.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(sent[0]!.headers).toEqual({});
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ model: "qwen/qwen3", max_tokens: 1024 });
  });

  it("asks OpenAI with this device's key, for JSON and without a temperature", async () => {
    const sent: Parameters<ChatPost>[0][] = [];
    const post: ChatPost = async (sentRequest) => {
      sent.push(sentRequest);
      return { status: 200, text: answer(advice) };
    };
    const partner = { provider: "openai" as const, openaiModel: "some-model", openaiKeySecret: "openai" };
    await askProcessingPartner(partner, settings.agent, { local: async () => "", openai: () => "sk-test" }, request, post);
    expect(sent[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent[0]!.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "some-model", response_format: { type: "json_object" }, max_completion_tokens: 4096 });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("says what is missing or went wrong in words", async () => {
    const openai = { provider: "openai" as const, openaiModel: "some-model", openaiKeySecret: "" };
    await expect(askProcessingPartner(openai, settings.agent, { local: async () => "", openai: () => "" }, request, async () => ({ status: 200, text: "" })))
      .rejects.toThrow("No OpenAI API key is set on this device.");
    await expect(askProcessingPartner(openai, settings.agent, { local: async () => "", openai: () => "sk" }, request, async () => ({ status: 401, text: "" })))
      .rejects.toThrow("OpenAI answered 401: the API key was refused.");
    await expect(askProcessingPartner(openai, settings.agent, { local: async () => "", openai: () => "sk" }, request, async () => { throw new Error("offline"); }))
      .rejects.toThrow("Is this device online?");
  });

  it("is offered where it can be reached", () => {
    const local = settings.processingPartner;
    const openai = { provider: "openai" as const, openaiModel: "some-model", openaiKeySecret: "openai" };
    expect(processingPartnerAvailable(local, true, { openai: () => "" })).toBe(true);
    expect(processingPartnerAvailable(local, false, { openai: () => "sk" })).toBe(false);
    expect(processingPartnerAvailable(openai, false, { openai: () => "sk" })).toBe(true);
    expect(processingPartnerAvailable(openai, true, { openai: () => "" })).toBe(false);
    expect(processingPartnerAvailable({ ...openai, openaiModel: "" }, true, { openai: () => "sk" })).toBe(false);
  });
});
