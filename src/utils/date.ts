export function localDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The local day and wall-clock time, e.g. `2026-09-14 08:30`. */
export function localDateTime(date: Date): string {
  return `${localDate(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function addLocalDays(value: string, amount: number): string {
  const parsed = parseDateOnly(value);
  if (!parsed) return value;
  parsed.setDate(parsed.getDate() + amount);
  return localDate(parsed);
}

export function parseDateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function isOverdue(value: string | undefined, today = localDate()): boolean {
  return Boolean(value && value < today);
}
