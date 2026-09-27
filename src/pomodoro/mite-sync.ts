import { requestUrl, type App } from "obsidian";
import { MITE, miteEntry, miteTargetFor, unsentSessions, type MiteSettings } from "../domain/mite";
import type { Project } from "../domain/types";
import type { PomodoroService } from "./pomodoro-service";

export type MiteRequest = (request: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  contentType?: string;
  throw: boolean;
}) => Promise<{ status: number; text: string; json?: unknown }>;

export interface MiteSyncResult {
  sent: number;
  /** Sessions whose Project has no mite project yet. */
  unmapped: number;
  failed: number;
  error: string;
}

export interface MiteChoice {
  id: number;
  name: string;
}

// mite asks every client to name itself and a contact.
const USER_AGENT = "Dragonglass GTD (Obsidian plugin dragonglass-gtd)";

/**
 * Sends finished Pomodoros to mite, each as its own time entry, and records the entry's id
 * in the session so it is sent once. The API key is read from Obsidian's secret storage
 * when needed; the settings hold only its name.
 */
export class MiteSync {
  private running: Promise<MiteSyncResult> | null = null;

  constructor(
    private readonly app: App,
    private readonly pomodoro: PomodoroService,
    private readonly getSettings: () => MiteSettings,
    private readonly getProjects: () => readonly Project[],
    private readonly request: MiteRequest = requestUrl as unknown as MiteRequest,
  ) {}

  /** Whether sessions can be sent at all: turned on, with an account and a key on this device. */
  ready(): boolean {
    const settings = this.getSettings();
    return settings.enabled && Boolean(settings.account) && Boolean(this.apiKey());
  }

  /** How many finished sessions haven't been sent, and how many of them have no mite project. */
  pending(): { unsent: number; unmapped: number } {
    const settings = this.getSettings();
    const sessions = unsentSessions(this.pomodoro.getStore(), settings.sendFrom);
    const projects = this.getProjects();
    return {
      unsent: sessions.length,
      unmapped: sessions.filter((session) => !miteTargetFor(session.projectId, projects, settings.projects)).length,
    };
  }

  /** Sends every unsent session with a mite project. One run at a time; a second call joins it. */
  sync(): Promise<MiteSyncResult> {
    if (this.running) return this.running;
    const run = this.send().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  async projects(): Promise<MiteChoice[]> {
    const list = await this.get("/projects.json");
    return choices(list, "project", (project) => (project.customer_name ? `${String(project.name)} (${String(project.customer_name)})` : String(project.name)));
  }

  async services(): Promise<MiteChoice[]> {
    return choices(await this.get("/services.json"), "service", (service) => String(service.name));
  }

  private async send(): Promise<MiteSyncResult> {
    const result: MiteSyncResult = { sent: 0, unmapped: 0, failed: 0, error: "" };
    const settings = this.getSettings();
    if (!settings.enabled) return result;
    const key = this.apiKey();
    if (!settings.account || !key) {
      result.error = "Set the mite account and API key in the settings first.";
      return result;
    }
    await this.pomodoro.load();
    const projects = this.getProjects();
    for (const session of unsentSessions(this.pomodoro.getStore(), settings.sendFrom)) {
      const target = miteTargetFor(session.projectId, projects, settings.projects);
      if (!target) {
        result.unmapped += 1;
        continue;
      }
      try {
        const response = await this.call("POST", "/time_entries.json", key, { time_entry: miteEntry(session, target, settings) });
        const id = entryId(response);
        if (!id) throw new Error("mite didn't return the new entry.");
        await this.pomodoro.recordExternal(session.id, MITE, String(id));
        result.sent += 1;
      } catch (error) {
        result.failed += 1;
        result.error = error instanceof Error ? error.message : String(error);
        // A wrong key or account fails every session the same way.
        if (/401|403|404/.test(result.error)) break;
      }
    }
    return result;
  }

  private async get(path: string): Promise<unknown> {
    const key = this.apiKey();
    if (!this.getSettings().account || !key) throw new Error("Set the mite account and API key first.");
    return this.call("GET", path, key);
  }

  private async call(method: string, path: string, key: string, body?: unknown): Promise<unknown> {
    const response = await this.request({
      url: `https://${this.getSettings().account}.mite.de${path}`,
      method,
      headers: { "X-MiteApiKey": key, "User-Agent": USER_AGENT, Accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body), contentType: "application/json" }),
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      const reason = response.status === 401 ? "the API key was refused"
        : response.status === 404 ? "the account wasn't found"
          : response.status === 423 ? "the entry is locked"
            : (errorText(response.text) || "the request failed");
      throw new Error(`mite: ${reason} (HTTP ${response.status}).`);
    }
    return response.text ? JSON.parse(response.text) : null;
  }

  private apiKey(): string {
    const name = this.getSettings().apiKeySecret;
    return name ? this.app.secretStorage.getSecret(name) ?? "" : "";
  }
}

function entryId(response: unknown): number | null {
  const entry = isRecord(response) && isRecord(response.time_entry) ? response.time_entry : null;
  return entry && Number.isInteger(entry.id) ? entry.id as number : null;
}

function choices(list: unknown, wrapper: string, name: (value: Record<string, unknown>) => string): MiteChoice[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const value = isRecord(entry) && isRecord(entry[wrapper]) ? entry[wrapper] as Record<string, unknown> : null;
    return value && Number.isInteger(value.id) && value.archived !== true ? [{ id: value.id as number, name: name(value) }] : [];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function errorText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
