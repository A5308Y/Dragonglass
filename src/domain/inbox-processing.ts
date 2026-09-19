/** Default title used when clarifying an Inbox Item into a Project or Action. */
export function inboxProcessingPrefill(title: string): string {
  return Array.from(title).slice(0, 50).join("");
}
