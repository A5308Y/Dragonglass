/**
 * Mail HTML as Markdown that is safe to store in a note and render.
 *
 * Senders write arbitrary HTML, so only a small, known subset survives as
 * structure: paragraphs, line breaks, headings, emphasis, lists, quotes and links
 * to the web or to mail addresses. Everything else is reduced to its text, and
 * every character of that text that Markdown or Obsidian could read as syntax is
 * escaped: raw HTML, links, embeds, tags, math, comments and highlights alike.
 * Images are never loaded; one with a description leaves `[image: …]` behind,
 * since remote images are how senders see that a message was opened.
 */

import { decodeEntities } from "./text";

type FrameKind = "root" | "strong" | "em" | "link" | "quote" | "heading" | "skip";

interface Frame {
  kind: FrameKind;
  /** The tag that opened the frame, which is the one that closes it. */
  tag: string;
  text: string;
  href?: string | undefined;
  level?: number;
}

interface List {
  ordered: boolean;
  next: number;
}

const DROPPED = /<(script|style|head|title|template|noscript|svg|object|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "center",
  "table", "tbody", "thead", "tfoot", "tr", "td", "th", "dl", "dt", "dd", "figure", "figcaption",
  "address", "form", "fieldset", "ul", "ol",
]);
const PARAGRAPH_TAGS = new Set(["p", "ul", "ol", "table", "dl", "figure"]);
const VOID_TAGS = new Set(["br", "hr", "img", "meta", "link", "input", "wbr", "col", "area", "base", "source"]);

export function htmlToMarkdown(html: string): string {
  const source = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<[!?][^>]*>/g, "")
    .replace(DROPPED, " ")
    .replace(/<(script|style)\b[\s\S]*$/gi, " ");

  const stack: Frame[] = [{ kind: "root", tag: "", text: "" }];
  const lists: List[] = [];
  let preDepth = 0;
  const top = () => stack[stack.length - 1]!;
  const skipping = () => stack.some((frame) => frame.kind === "skip");
  const emit = (value: string) => { top().text += value; };
  // Block boundaries end the line, or leave a blank one, without stacking up blank lines.
  const breakLine = (count: 1 | 2) => {
    const frame = top();
    const trailing = /\n*[ \t]*$/.exec(frame.text)![0].split("\n").length - 1;
    if (frame.text.trim()) frame.text += "\n".repeat(Math.max(0, count - trailing));
  };

  const close = (tag: string) => {
    const index = findLast(stack, (frame) => frame.tag === tag);
    if (index <= 0) return;
    while (stack.length > index) {
      const frame = stack.pop()!;
      emit(renderFrame(frame));
    }
  };

  for (const token of source.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g)) {
    const [raw, name, attributes = ""] = token;
    if (!name) {
      if (skipping()) continue;
      const decoded = decodeEntities(raw);
      if (preDepth > 0) {
        emit(escapeText(decoded, true));
        continue;
      }
      const collapsed = decoded.replace(/\s+/g, " ");
      // Indentation in the HTML source is not text: a space starting a line is dropped.
      if (collapsed === " " && (top().text === "" || top().text.endsWith("\n"))) continue;
      emit(escapeText(collapsed, false));
      continue;
    }

    const tag = name.toLowerCase();
    const closing = raw.startsWith("</");
    if (skipping() && !(closing && top().tag === tag && top().kind === "skip")) {
      // Nested tags of the same name still count, so the skip ends at the right one.
      if (!closing && !VOID_TAGS.has(tag) && top().kind === "skip" && top().tag === tag) stack.push({ kind: "skip", tag, text: "" });
      continue;
    }

    if (closing) {
      if (tag === "pre") preDepth = Math.max(0, preDepth - 1);
      if (tag === "ul" || tag === "ol") lists.pop();
      close(tag);
      // Inside a list item a paragraph only ends the line, or it would break the list.
      const paragraph = (PARAGRAPH_TAGS.has(tag) && !(tag === "p" && lists.length > 0)) || tag === "pre";
      if (BLOCK_TAGS.has(tag) || tag === "li" || tag === "pre") breakLine(paragraph ? 2 : 1);
      continue;
    }

    if (hidden(attributes)) {
      if (!VOID_TAGS.has(tag)) stack.push({ kind: "skip", tag, text: "" });
      continue;
    }

    switch (tag) {
      case "br":
        emit("\n");
        break;
      case "hr":
        emit("\n\n---\n\n");
        break;
      case "img": {
        const alt = attribute(attributes, "alt")?.trim();
        if (alt) emit(escapeText(`[image: ${alt}]`, false));
        break;
      }
      case "strong":
      case "b":
        stack.push({ kind: "strong", tag, text: "" });
        break;
      case "em":
      case "i":
        stack.push({ kind: "em", tag, text: "" });
        break;
      case "a":
        stack.push({ kind: "link", tag, text: "", href: safeHref(attribute(attributes, "href")) });
        break;
      case "blockquote":
        stack.push({ kind: "quote", tag, text: "" });
        break;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        stack.push({ kind: "heading", tag, text: "", level: Number(tag[1]) });
        break;
      case "pre":
        preDepth += 1;
        breakLine(2);
        break;
      case "ul":
      case "ol":
        lists.push({ ordered: tag === "ol", next: Number(attribute(attributes, "start")) || 1 });
        breakLine(lists.length > 1 ? 1 : 2);
        break;
      case "li": {
        const list = lists[lists.length - 1];
        const indent = "    ".repeat(Math.max(0, lists.length - 1));
        const marker = list?.ordered ? `${list.next++}. ` : "- ";
        breakLine(1);
        emit(`${indent}${marker}`);
        break;
      }
      default:
        // A list item's own paragraph continues the line its marker started.
        if (BLOCK_TAGS.has(tag) && lists.length === 0) breakLine(PARAGRAPH_TAGS.has(tag) ? 2 : 1);
        else if (BLOCK_TAGS.has(tag) && tag !== "p" && tag !== "div") breakLine(1);
    }
  }

  while (stack.length > 1) {
    const frame = stack.pop()!;
    if (frame.kind !== "skip") emit(renderFrame(frame));
  }
  return tidy(stack[0]!.text);
}

function renderFrame(frame: Frame): string {
  switch (frame.kind) {
    case "strong":
      return wrapInline(frame.text, "**");
    case "em":
      return wrapInline(frame.text, "*");
    case "link": {
      // Link text stays on one line, or the link would end at the break.
      const label = frame.text.replace(/\s+/g, " ").trim();
      if (!frame.href) return frame.text;
      if (!label) return "";
      return `[${label}](${frame.href})`;
    }
    case "heading": {
      const title = frame.text.replace(/\s+/g, " ").trim();
      return title ? `\n\n${"#".repeat(frame.level ?? 1)} ${title}\n\n` : "";
    }
    case "quote": {
      const body = tidy(frame.text);
      return body ? `\n\n${body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")}\n\n` : "";
    }
    default:
      return "";
  }
}

/** Emphasis must hug its text, so surrounding spaces move outside the markers. */
function wrapInline(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  const [, before, inner, after] = match;
  if (!inner || inner.includes("\n\n")) return text;
  return `${before}${marker}${inner}${marker}${after}`;
}

/**
 * Escapes what Markdown or Obsidian would read as syntax. Leading list, heading and
 * quote markers are escaped too, since a text run may start a line.
 */
function escapeText(text: string, preformatted: boolean): string {
  const escaped = text.replace(/[\\`*_[\]<>#|~$%=&]/g, "\\$&");
  const lineStart = preformatted ? /^([ \t]*)([-+]|\d+[.)])/gm : /^([ \t]*)([-+]|\d+[.)])/g;
  return escaped.replace(lineStart, (_match, space: string, marker: string) => `${space}${marker.replace(/[-+.)]/, "\\$&")}`);
}

/** Collapses the blank lines and stray spaces the tag boundaries left behind. */
function tidy(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^ (?=\S)/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hidden(attributes: string): boolean {
  const style = attribute(attributes, "style")?.toLowerCase().replace(/\s+/g, "") ?? "";
  return /(^|;)display:none/.test(style) || /(^|;)visibility:hidden/.test(style)
    || (/(^|;)max-height:0(px)?(;|$)/.test(style) && /overflow:hidden/.test(style))
    || /(^|\s)hidden(\s|=|$)/i.test(attributes);
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attributes);
  if (!match) return undefined;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** Web and mail links only, written so nothing in them can end the Markdown link early. */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!/^(https?:|mailto:)/i.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return undefined;
    return url.toString().replace(/[()<> ]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    return undefined;
  }
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index]!)) return index;
  return -1;
}
