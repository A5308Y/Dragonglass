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
  if (pattern.test(content)) return content.replace(pattern, section);
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

export function parseDiaryEntries(content: string): DiaryEntry[] {
  const body = readMarkdownSection(content, "Diary");
  if (!body) return [];
  const entries: DiaryEntry[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const structured = /^-\s+\*\*([^*]+)\*\*\s*[—-]\s*(.+)$/.exec(line);
    if (structured) {
      entries.push({ timestamp: structured[1]!.trim(), text: structured[2]!.trim() });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    entries.push({ text: (bullet?.[1] ?? line).trim() });
  }
  return entries;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
