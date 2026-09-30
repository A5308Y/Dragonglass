export interface DiaryEntry {
  timestamp?: string;
  text: string;
}

export function noteBody(content: string, generatedTitle?: string): string {
  let body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  if (generatedTitle) {
    const escaped = escapeRegExp(generatedTitle);
    body = body.replace(new RegExp(`^# ${escaped}[ \\t]*\\r?\\n?`), "").trim();
  }
  return body;
}

export function replaceNoteBody(content: string, body: string): string {
  const frontmatter = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/.exec(content)?.[1] ?? "";
  const cleanBody = body.trimEnd();
  return `${frontmatter}${frontmatter ? "\n" : ""}${cleanBody}${cleanBody ? "\n" : ""}`;
}

export function readMarkdownSection(content: string, heading: string, level = 2): string {
  const marker = "#".repeat(level);
  const escaped = escapeRegExp(heading);
  const match = new RegExp(`^${marker} ${escaped}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^#{1,${level}} |$(?![\\s\\S]))`, "m").exec(content);
  return match?.[1]?.trim() ?? "";
}

export function setMarkdownSection(content: string, heading: string, value: string, level = 2): string {
  const marker = "#".repeat(level);
  const escaped = escapeRegExp(heading);
  const section = `${marker} ${heading}\n\n${value.trim()}\n`;
  const pattern = new RegExp(`^${marker} ${escaped}[ \\t]*\\r?\\n[\\s\\S]*?(?=^#{1,${level}} |$(?![\\s\\S]))`, "m");
  // A section followed by another heading keeps the blank line before it, so writing a
  // section back unchanged leaves the note as it was.
  if (pattern.test(content)) {
    return content.replace(pattern, (match: string, offset: number) => (offset + match.length >= content.length ? section : `${section}\n`));
  }
  return `${content.trimEnd()}\n\n${section}`;
}

export function prependMarkdownSectionLine(content: string, heading: string, line: string, level = 2): string {
  const marker = "#".repeat(level);
  const escaped = escapeRegExp(heading);
  const pattern = new RegExp(`^${marker} ${escaped}[ \\t]*\\r?\\n`, "m");
  const match = pattern.exec(content);
  if (!match || match.index === undefined) return `${content.trimEnd()}\n\n${marker} ${heading}\n\n${line}\n`;
  const insertion = match.index + match[0].length;
  return `${content.slice(0, insertion)}\n${line}${content.slice(insertion)}`;
}

/** One Diary bullet, with any further lines indented so they stay part of the same list item. */
export function diaryEntryMarkdown(timestamp: string, text: string): string {
  const [first = "", ...rest] = text.replace(/\r\n?/g, "\n").trim().split("\n");
  return [`- **${timestamp}** — ${first}`, ...rest.map((line) => (line.trim() ? `  ${line.trimEnd()}` : ""))].join("\n");
}

export function parseDiaryEntries(content: string): DiaryEntry[] {
  const body = readMarkdownSection(content, "Diary");
  if (!body) return [];
  const entries: DiaryEntry[] = [];
  let pendingBlank = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      pendingBlank = true;
      continue;
    }
    const previous = entries[entries.length - 1];
    if (previous && /^\s/.test(rawLine)) {
      previous.text = `${previous.text}\n${pendingBlank ? "\n" : ""}${dedentContinuation(rawLine)}`;
      pendingBlank = false;
      continue;
    }
    pendingBlank = false;
    const structured = /^-\s+\*\*([^*]+)\*\*\s*[—-]\s*(.*)$/.exec(line);
    if (structured) {
      entries.push({ timestamp: structured[1]!.trim(), text: structured[2]!.trim() });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    entries.push({ text: (bullet?.[1] ?? line).trim() });
  }
  return entries;
}

function dedentContinuation(rawLine: string): string {
  return (rawLine.startsWith("  ") ? rawLine.slice(2) : rawLine.trimStart()).trimEnd();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
