/**
 * GitHub pull requests named in Inbox Items, mostly GitHub's notification emails, so
 * one press can turn "please review" into a Next Action. GitHub sends an email for
 * every review request, comment and push, so an Action that already links the pull
 * request is reused instead of made again.
 */

export interface PullRequestLink {
  /** The pull request's own address, without a tab, comment anchor or query. */
  url: string;
  owner: string;
  repository: string;
  number: number;
}

const PULL_REQUEST = /https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/;

/** The first pull request linked in the text, or `null`. */
export function findPullRequest(text: string): PullRequestLink | null {
  const match = PULL_REQUEST.exec(text);
  if (!match) return null;
  const [, owner, repository, number] = match as unknown as [string, string, string, string];
  return { url: `https://github.com/${owner}/${repository}/pull/${number}`, owner, repository, number: Number(number) };
}

/** How the processor's button names the pull request, e.g. `dragonglass#123`. */
export function pullRequestLabel(pr: PullRequestLink): string {
  return `${pr.repository}#${pr.number}`;
}

/**
 * The review Action's title: "Review" and a link the board shows, named after the
 * repository, the number and the pull request's title as the email subject gives it
 * ("Re: [owner/repo] Add checklists (PR #123)" gives "Add checklists"). The subject
 * comes from an email, so characters that would end the link are taken out.
 */
export function reviewActionTitle(pr: PullRequestLink, subject: string): string {
  const title = subject
    .replace(/^(?:(?:re|fwd?|aw|wg)\s*:\s*)+/i, "")
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/\s*\((?:PR\s*)?#\d+\)\s*$/i, "")
    .replace(/[[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `Review [${pullRequestLabel(pr)}${title ? `: ${title}` : ""}](${pr.url})`;
}

/** Whether an Action's title links this pull request. */
export function linksPullRequest(title: string, pr: PullRequestLink): boolean {
  return findPullRequest(title)?.url === pr.url;
}
