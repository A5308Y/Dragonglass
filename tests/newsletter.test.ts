import { describe, expect, it } from "vitest";
import { findNewsletter, linksNewsletter, readActionTitle } from "../src/domain/newsletter";

const neuron = [
  "[Read Online](https://www.theneurondaily.com/p/openai-ships-agents?utm_source=www.theneurondaily.com&utm_medium=newsletter)",
  "",
  "Welcome, humans.",
  "[Sponsor](https://partner.example/offer?ref=neuron)",
].join("\n");

describe("Newsletters in Inbox Items", () => {
  it("finds a known newsletter's post by its address, without tracking", () => {
    expect(findNewsletter(neuron)).toEqual({ url: "https://www.theneurondaily.com/p/openai-ships-agents", source: "theneurondaily.com" });
    expect(findNewsletter("[Today's issue](https://theneurondaily.com/p/x/)")?.url).toBe("https://theneurondaily.com/p/x/");
  });

  it("finds any newsletter's web version by what its link says", () => {
    expect(findNewsletter("Hi\n[View this email in your browser](https://mailchi.mp/acme/issue-12?e=abc&utm_campaign=x)"))
      .toEqual({ url: "https://mailchi.mp/acme/issue-12?e=abc", source: "mailchi.mp" });
    expect(findNewsletter("[Web version](https://www.acme.com/news/12)")?.source).toBe("acme.com");
    expect(findNewsletter("[Read online](https://acme.com/12#top)")?.url).toBe("https://acme.com/12");
  });

  it("ignores ordinary links and other pages of a known newsletter", () => {
    expect(findNewsletter("[Our website](https://acme.com) and [Unsubscribe](https://acme.com/u)")).toBeNull();
    expect(findNewsletter("[Subscribe](https://www.theneurondaily.com/subscribe)")).toBeNull();
    expect(findNewsletter("https://www.theneurondaily.com/p/bare-text")).toBeNull();
  });

  it("titles the Action after the subject and recognises it again", () => {
    const link = findNewsletter(neuron)!;
    const title = readActionTitle(link, "Fwd: 😺 OpenAI [finally] ships (agents)");
    expect(title).toBe("Read [😺 OpenAI finally ships agents](https://www.theneurondaily.com/p/openai-ships-agents)");
    expect(readActionTitle(link, "")).toBe("Read [theneurondaily.com](https://www.theneurondaily.com/p/openai-ships-agents)");
    expect(linksNewsletter(title, link)).toBe(true);
    expect(linksNewsletter("Read [Other](https://www.theneurondaily.com/p/other)", link)).toBe(false);
  });
});
