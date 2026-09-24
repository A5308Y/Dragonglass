/** Opens a web link in the browser. Only http and https links are opened. */
export function openWebLink(raw: string): void {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https links can be opened.");
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}
