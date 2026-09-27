import { describe, expect, it } from "vitest";
import type { App, TFile } from "obsidian";
import {
  MITE,
  miteAccount,
  miteEntry,
  miteMinutes,
  miteTargetFor,
  parseMiteSettings,
  unsentSessions,
  withExternalLink,
  type MiteSettings,
} from "../src/domain/mite";
import type { PomodoroSession, PomodoroStore } from "../src/domain/pomodoro";
import type { Project } from "../src/domain/types";
import { MiteSync, type MiteRequest } from "../src/pomodoro/mite-sync";
import type { PomodoroService } from "../src/pomodoro/pomodoro-service";

const file = { path: "Project.md" } as TFile;
const project = (id: string, changes: Partial<Project> = {}): Project => ({
  type: "gtd-project",
  id,
  title: id,
  status: "active",
  created: "2026-09-01",
  file,
  ...changes,
});

const session = (id: string, changes: Partial<PomodoroSession> = {}): PomodoroSession => ({
  id,
  projectId: "child",
  projectTitle: "Tiles",
  projectPath: "Tiles.md",
  intention: "Compare suppliers",
  focusActionIds: [],
  completedActionIds: [],
  plannedMinutes: 25,
  startedAt: "2026-09-27T08:00:00.000Z",
  endedAt: "2026-09-27T08:25:00.000Z",
  focusedSeconds: 25 * 60,
  status: "completed",
  outcome: "achieved",
  reflection: "",
  external: {},
  ...changes,
});

const settings = (changes: Partial<MiteSettings> = {}): MiteSettings => ({
  ...parseMiteSettings({}, "2026-09-01"),
  enabled: true,
  account: "acme",
  apiKeySecret: "mite-key",
  projects: { parent: { projectId: 11, serviceId: null, label: "House" } },
  ...changes,
});

describe("mite time entries", () => {
  it("adds the break to a completed Pomodoro and rounds to whole minutes", () => {
    expect(miteMinutes(session("a"), 5)).toBe(30);
    expect(miteMinutes(session("a", { focusedSeconds: 24 * 60 + 40 }), 5)).toBe(30);
  });

  it("counts only the focused time of a Pomodoro stopped early", () => {
    expect(miteMinutes(session("a", { status: "stopped", focusedSeconds: 12 * 60 + 29 }), 5)).toBe(12);
  });

  it("takes the mite project from the nearest Project above that has one", () => {
    const projects = [project("parent"), project("child", { parentProjectId: "parent" })];
    expect(miteTargetFor("child", projects, settings().projects)?.projectId).toBe(11);
    expect(miteTargetFor("other", [project("other")], settings().projects)).toBeNull();
  });

  it("builds the entry with the default service when the Project names none", () => {
    const entry = miteEntry(session("a"), settings().projects.parent!, { breakMinutes: 5, defaultServiceId: 7 });
    expect(entry).toEqual({ date_at: "2026-09-27", minutes: 30, note: "🍅 Tiles: Compare suppliers — achieved", project_id: 11, service_id: 7 });
  });

  it("sends sessions once, from the chosen day on, and skips ones under a minute", () => {
    const store: PomodoroStore = {
      version: 1,
      active: null,
      sessions: [
        session("sent", { external: { [MITE]: { id: "1", syncedAt: "x" } } }),
        session("old", { endedAt: "2026-08-01T08:25:00.000Z", startedAt: "2026-08-01T08:00:00.000Z" }),
        session("tiny", { focusedSeconds: 30, status: "stopped" }),
        session("new"),
      ],
    };
    expect(unsentSessions(store, "2026-09-01").map((entry) => entry.id)).toEqual(["new"]);
  });

  it("reads an account from a pasted address", () => {
    expect(miteAccount("https://Acme.mite.de/daily")).toBe("acme");
  });
});

describe("Sending to mite", () => {
  it("posts each unsent session and records the entry id; unmapped ones wait", async () => {
    let store: PomodoroStore = {
      version: 1,
      active: null,
      sessions: [session("mapped"), session("unmapped", { projectId: "loose" })],
    };
    const pomodoro = {
      load: async () => undefined,
      getStore: () => store,
      recordExternal: async (sessionId: string, integration: string, id: string) => {
        store = withExternalLink(store, sessionId, integration, id, "now");
      },
    } as unknown as PomodoroService;
    const app = { secretStorage: { getSecret: (name: string) => (name === "mite-key" ? "secret" : null) } } as unknown as App;
    const requests: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const request: MiteRequest = async (sent) => {
      requests.push(sent);
      return { status: 201, text: JSON.stringify({ time_entry: { id: 99 } }) };
    };
    const projects = [project("parent"), project("child", { parentProjectId: "parent" }), project("loose")];
    const sync = new MiteSync(app, pomodoro, () => settings(), () => projects, request);

    const result = await sync.sync();

    expect(result).toEqual({ sent: 1, unmapped: 1, failed: 0, error: "" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("https://acme.mite.de/time_entries.json");
    expect(requests[0]!.headers["X-MiteApiKey"]).toBe("secret");
    expect(JSON.parse(requests[0]!.body!).time_entry.minutes).toBe(30);
    expect(store.sessions[0]!.external[MITE]?.id).toBe("99");
    expect((await sync.sync()).sent).toBe(0);
    // Only the mapped session is ever sent, and only by creating an entry.
    expect(requests.map((sent) => sent.method)).toEqual(["POST"]);
  });

  it("stops at a refused key instead of trying every session", async () => {
    const store: PomodoroStore = { version: 1, active: null, sessions: [session("a"), session("b", { startedAt: "2026-09-27T09:00:00.000Z" })] };
    const pomodoro = { load: async () => undefined, getStore: () => store, recordExternal: async () => undefined } as unknown as PomodoroService;
    const app = { secretStorage: { getSecret: () => "wrong" } } as unknown as App;
    let calls = 0;
    const request: MiteRequest = async () => {
      calls += 1;
      return { status: 401, text: "" };
    };
    const sync = new MiteSync(app, pomodoro, () => settings(), () => [project("parent"), project("child", { parentProjectId: "parent" })], request);
    const result = await sync.sync();
    expect(calls).toBe(1);
    expect(result.error).toContain("API key was refused");
  });
});
