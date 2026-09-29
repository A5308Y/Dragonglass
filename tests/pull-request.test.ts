import { describe, expect, it } from "vitest";
import { findPullRequest, linksPullRequest, pullRequestLabel, reviewActionTitle } from "../src/domain/pull-request";

const email = [
  "From: Mar <notifications@github.com>",
  "",
  "> @andy requested your review on: acme/dragonglass#123 Add checklists.",
  ">",
  "> Reply to this email directly, [view it on GitHub](https://github.com/acme/dragonglass/pull/123#pullrequestreview-99).",
].join("\n");

describe("Pull requests in Inbox Items", () => {
  it("finds the pull request without its anchor, tab or query", () => {
    expect(findPullRequest(email)).toEqual({ url: "https://github.com/acme/dragonglass/pull/123", owner: "acme", repository: "dragonglass", number: 123 });
    expect(findPullRequest("https://github.com/acme/app.js/pull/7/files?diff=split")?.url).toBe("https://github.com/acme/app.js/pull/7");
  });

  it("ignores issues and other sites", () => {
    expect(findPullRequest("https://github.com/acme/dragonglass/issues/5")).toBeNull();
    expect(findPullRequest("https://evil.example/github.com/acme/x/pull/1")).toBeNull();
    expect(findPullRequest("no links here")).toBeNull();
  });

  it("titles the review after the subject, without GitHub's decoration", () => {
    const pr = findPullRequest(email)!;
    expect(pullRequestLabel(pr)).toBe("dragonglass#123");
    expect(reviewActionTitle(pr, "Re: [acme/dragonglass] Add checklists (PR #123)"))
      .toBe("Review [dragonglass#123: Add checklists](https://github.com/acme/dragonglass/pull/123)");
    expect(reviewActionTitle(pr, "[acme/dragonglass] Fix [brackets] (and parens) (#123)"))
      .toBe("Review [dragonglass#123: Fix brackets and parens](https://github.com/acme/dragonglass/pull/123)");
    expect(reviewActionTitle(pr, "")).toBe("Review [dragonglass#123](https://github.com/acme/dragonglass/pull/123)");
  });

  it("recognises an Action that already links the same pull request", () => {
    const pr = findPullRequest(email)!;
    expect(linksPullRequest("Review [dragonglass#123: Add checklists](https://github.com/acme/dragonglass/pull/123)", pr)).toBe(true);
    expect(linksPullRequest("Review [dragonglass#12](https://github.com/acme/dragonglass/pull/12)", pr)).toBe(false);
  });
});
