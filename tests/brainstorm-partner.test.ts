import { describe, expect, it } from "vitest";
import { localChatEndpoint, parsePartnerReply, partnerMessages } from "../src/domain/brainstorm-partner";
import { askLocalPartner, type PartnerPost } from "../src/brainstorm/local-partner";
import { defaultSettings } from "../src/state/defaults";

const request = { topic: "Team offsite", desiredOutcome: "A day people remember", ideas: "Hike\nCooking class", offered: ["Escape room"] };

describe("The brainstorm partner", () => {
  it("sends the topic, the outcome, the ideas and what it already offered", () => {
    const [system, user] = partnerMessages(request);
    expect(system?.content).toContain("JSON only");
    expect(user?.content).toBe(
      "Topic: Team offsite\nDesired outcome: A day people remember\n\nIdeas so far:\nHike\nCooking class\n\n"
      + "You already suggested, so don't repeat:\n- Escape room",
    );
  });

  it("reads JSON after a model's thinking or inside a code fence, and drops repeats", () => {
    const reply = "<think>Let me see…</think>\n```json\n{\"ideas\": [\"Boat trip\", \"hike\", \"Escape room!\", \" Boat trip \"], \"considerations\": [\"Who can't walk far?\"]}\n```";
    expect(parsePartnerReply(reply, request)).toEqual({ ideas: ["Boat trip"], considerations: ["Who can't walk far?"] });
  });

  it("falls back to the list lines of a plain answer", () => {
    expect(parsePartnerReply("Some ideas:\n- Picnic\n2. Volunteering day\nThat's all.", request))
      .toEqual({ ideas: ["Picnic", "Volunteering day"], considerations: [] });
  });

  it("talks only to a model server on this Mac", () => {
    expect(localChatEndpoint("http://host.docker.internal:1234")).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(localChatEndpoint("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1/chat/completions");
    expect(() => localChatEndpoint("https://api.example.com")).toThrow("only talks to a model server on this Mac");
    expect(() => localChatEndpoint("not a url")).toThrow("isn't a valid address");
  });
});

describe("Asking the local model", () => {
  const settings = { ...defaultSettings().agent, localModel: "qwen/qwen3", localModelUrl: "http://host.docker.internal:1234" };
  const answer = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });

  it("posts the session to this Mac's server, with the key when there is one", async () => {
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const post: PartnerPost = async (request) => {
      sent.push(request);
      return { status: 200, text: answer('{"ideas": ["Boat trip"], "considerations": []}') };
    };
    const result = await askLocalPartner(settings, async () => "secret", request, post);
    expect(result).toEqual({ ideas: ["Boat trip"], considerations: [] });
    expect(sent[0]!.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(sent[0]!.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ model: "qwen/qwen3", messages: [{ role: "system" }, { role: "user" }] });
  });

  it("says what went wrong in words", async () => {
    await expect(askLocalPartner(settings, async () => "", request, async () => { throw new Error("ECONNREFUSED"); }))
      .rejects.toThrow("Is LM Studio running");
    await expect(askLocalPartner(settings, async () => "", request, async () => ({ status: 404, text: "" })))
      .rejects.toThrow("answered 404");
  });
});
