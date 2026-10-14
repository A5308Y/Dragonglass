import { describe, expect, it } from "vitest";
import {
  emptyPomodoroStore,
  endsAt,
  finishPomodoro,
  focusedSeconds,
  logPastPomodoro,
  mergePomodoroStores,
  parsePomodoroStore,
  pausePomodoro,
  recordCompletedAction,
  remainingSeconds,
  restorePomodoro,
  discardPomodoro,
  resumePomodoro,
  startPomodoro,
  toTimeEntry,
  type PastPomodoro,
  type PomodoroStart,
} from "../src/domain/pomodoro";
import { ELM_PROTOCOL_VERSION, elmPomodoro, parsePomodoroCommand } from "../src/adapter/protocol";

const at = (clock: string) => new Date(`2026-09-22T${clock}:00.000Z`);
const start: PomodoroStart = {
  id: "01POMODORO",
  projectId: "P1",
  projectTitle: "Website",
  projectPath: "Clients > Website",
  intention: "  Draft the landing page copy  ",
  focusActionIds: ["A1", "A1", "A2"],
  plannedMinutes: 25,
};

describe("a Pomodoro session", () => {
  it("counts focus time and caps it at the planned length", () => {
    const store = startPomodoro(emptyPomodoroStore(), start, at("10:00"));
    const active = store.active!;
    expect(active.intention).toBe("Draft the landing page copy");
    expect(active.focusActionIds).toEqual(["A1", "A2"]);
    expect(focusedSeconds(active, at("10:10"))).toBe(600);
    expect(remainingSeconds(active, at("10:10"))).toBe(900);
    expect(endsAt(active, at("10:10"))).toEqual(at("10:25"));
    expect(focusedSeconds(active, at("11:00"))).toBe(1500);
    expect(remainingSeconds(active, at("11:00"))).toBe(0);
  });

  it("stops counting while paused", () => {
    let store = startPomodoro(emptyPomodoroStore(), start, at("10:00"));
    store = pausePomodoro(store, at("10:05"));
    expect(focusedSeconds(store.active!, at("10:30"))).toBe(300);
    expect(endsAt(store.active!, at("10:30"))).toBeNull();
    store = resumePomodoro(store, at("10:30"));
    expect(focusedSeconds(store.active!, at("10:40"))).toBe(900);
  });

  it("refuses to start without an intention or while another runs", () => {
    expect(() => startPomodoro(emptyPomodoroStore(), { ...start, intention: " " }, at("10:00"))).toThrow(/intention/);
    const running = startPomodoro(emptyPomodoroStore(), start, at("10:00"));
    expect(() => startPomodoro(running, start, at("10:01"))).toThrow(/already running/);
  });

  it("files a full session as completed and an early finish as stopped", () => {
    const running = recordCompletedAction(startPomodoro(emptyPomodoroStore(), start, at("10:00")), "A1");
    const full = finishPomodoro(running, { outcome: "achieved", reflection: " Done " }, at("10:27"));
    expect(full.active).toBeNull();
    expect(full.sessions[0]).toMatchObject({
      id: "01POMODORO",
      status: "completed",
      focusedSeconds: 1500,
      completedActionIds: ["A1"],
      outcome: "achieved",
      reflection: "Done",
      endedAt: at("10:27").toISOString(),
    });
    const early = finishPomodoro(running, { outcome: null, reflection: "" }, at("10:12"));
    expect(early.sessions[0]).toMatchObject({ status: "stopped", focusedSeconds: 720, outcome: null });
  });

  it("restores a discarded session unless another one has started", () => {
    const running = startPomodoro(emptyPomodoroStore(), start, at("10:00"));
    const discarded = discardPomodoro(running);
    expect(restorePomodoro(discarded, running.active!).active?.id).toBe("01POMODORO");
    const other = startPomodoro(discarded, { ...start, id: "02OTHER" }, at("10:01"));
    expect(restorePomodoro(other, running.active!).active?.id).toBe("02OTHER");
  });

  it("turns a session into a neutral time entry for a time tracker", () => {
    const store = finishPomodoro(startPomodoro(emptyPomodoroStore(), start, at("10:00")), { outcome: "partly", reflection: "" }, at("10:25"));
    expect(toTimeEntry(store.sessions[0]!)).toEqual({
      key: "01POMODORO",
      start: at("10:00").toISOString(),
      end: at("10:25").toISOString(),
      durationSeconds: 1500,
      project: "Clients > Website",
      description: "Draft the landing page copy",
      tags: ["pomodoro", "completed"],
    });
  });
});

describe("a session logged afterwards", () => {
  const past: PastPomodoro = {
    id: "01PAST",
    projectId: "P1",
    projectTitle: "Website",
    projectPath: "Clients > Website",
    intention: " Call with the designer ",
    startedAt: at("08:00"),
    minutes: 45,
    outcome: "achieved",
    reflection: "",
  };

  it("is filed as a full, manual session in start order", () => {
    const later = finishPomodoro(startPomodoro(emptyPomodoroStore(), start, at("10:00")), { outcome: null, reflection: "" }, at("10:25"));
    const store = logPastPomodoro(later, past, at("12:00"));
    expect(store.sessions.map((session) => session.id)).toEqual(["01POMODORO", "01PAST"]);
    expect(store.sessions[1]).toMatchObject({
      intention: "Call with the designer",
      startedAt: at("08:00").toISOString(),
      endedAt: at("08:45").toISOString(),
      plannedMinutes: 45,
      focusedSeconds: 2700,
      status: "completed",
      outcome: "achieved",
      external: {},
      manual: true,
    });
  });

  it("must be over already and needs a Project and an intention", () => {
    expect(() => logPastPomodoro(emptyPomodoroStore(), past, at("08:30"))).toThrow(/over already/);
    expect(() => logPastPomodoro(emptyPomodoroStore(), { ...past, projectId: "" }, at("12:00"))).toThrow(/Project/);
    expect(() => logPastPomodoro(emptyPomodoroStore(), { ...past, intention: " " }, at("12:00"))).toThrow(/for/);
    expect(() => logPastPomodoro(emptyPomodoroStore(), { ...past, minutes: 0 }, at("12:00"))).toThrow(/between 1 and 180/);
    expect(() => logPastPomodoro(emptyPomodoroStore(), { ...past, startedAt: new Date("nope") }, at("12:00"))).toThrow(/valid date/);
  });

  it("may not overlap a filed session or the one running now", () => {
    const filed = finishPomodoro(startPomodoro(emptyPomodoroStore(), start, at("08:30")), { outcome: null, reflection: "" }, at("08:55"));
    expect(() => logPastPomodoro(filed, past, at("12:00"))).toThrow(/overlaps “Draft the landing page copy”/);
    // Touching ends are fine.
    expect(logPastPomodoro(filed, { ...past, startedAt: at("07:45") }, at("12:00")).sessions).toHaveLength(2);
    const running = startPomodoro(emptyPomodoroStore(), start, at("08:40"));
    expect(() => logPastPomodoro(running, past, at("12:00"))).toThrow(/running now/);
  });

  it("stays marked as logged through the file and a merge", () => {
    const store = logPastPomodoro(emptyPomodoroStore(), past, at("12:00"));
    expect(parsePomodoroStore(JSON.parse(JSON.stringify(store)))).toEqual(store);
    const synced = { ...store, sessions: [{ ...store.sessions[0]!, external: { other: { id: "1", syncedAt: "x" } } }] };
    expect(mergePomodoroStores(emptyPomodoroStore(), store, synced).sessions[0]).toMatchObject({ manual: true });
  });
});

describe("the Pomodoro log file", () => {
  it("round-trips a store and keeps sync links", () => {
    const finished = finishPomodoro(startPomodoro(emptyPomodoroStore(), start, at("10:00")), { outcome: "achieved", reflection: "" }, at("10:25"));
    const synced = { ...finished, sessions: [{ ...finished.sessions[0]!, external: { toggl: { id: "987", syncedAt: "2026-09-22T11:00:00Z" } } }] };
    expect(parsePomodoroStore(JSON.parse(JSON.stringify(synced)))).toEqual(synced);
  });

  it("keeps a checklist session, which has no Project", () => {
    const onChecklist = { ...start, projectId: "", projectTitle: "Daily", projectPath: "", checklist: { runId: "R1", path: "GTD/Checklists/Daily.md" } };
    const finished = finishPomodoro(startPomodoro(emptyPomodoroStore(), onChecklist, at("10:00")), { outcome: null, reflection: "" }, at("10:25"));
    expect(parsePomodoroStore(JSON.parse(JSON.stringify(finished)))).toEqual(finished);
    expect(() => startPomodoro(emptyPomodoroStore(), { ...start, projectId: "" }, at("10:00"))).toThrow("Choose a Project or a checklist");
  });

  it("drops malformed sessions instead of failing", () => {
    const parsed = parsePomodoroStore({
      active: { id: "x" },
      sessions: [null, { id: "S1" }, { id: "S2", projectId: "P", startedAt: "2026-09-22T10:00:00Z", endedAt: "nope", plannedMinutes: 25, focusedSeconds: 10 }],
    });
    expect(parsed).toEqual(emptyPomodoroStore());
    expect(parsePomodoroStore("garbage")).toEqual(emptyPomodoroStore());
  });
});

describe("the Pomodoro view's data and commands", () => {
  const envelope = (command: unknown) => ({ protocolVersion: ELM_PROTOCOL_VERSION, requestId: "pomodoro-1", command });

  it("accepts well-formed commands and rejects the rest", () => {
    expect(parsePomodoroCommand(envelope({ type: "start-pomodoro", projectId: "P1", intention: "Draft", focusActionIds: ["A1"], minutes: 25 }))?.command.type)
      .toBe("start-pomodoro");
    expect(parsePomodoroCommand(envelope({ type: "finish-pomodoro", outcome: null, reflection: "" }))?.command.type).toBe("finish-pomodoro");
    expect(parsePomodoroCommand(envelope({ type: "finish-pomodoro", outcome: "partly", reflection: "ok" }))?.command.type).toBe("finish-pomodoro");
    expect(parsePomodoroCommand(envelope({ type: "start-pomodoro", projectId: "P1", intention: "Draft", focusActionIds: [], minutes: 0 }))).toBeNull();
    expect(parsePomodoroCommand(envelope({ type: "start-pomodoro", projectId: "P1", intention: "Draft", focusActionIds: [], minutes: 25.5 }))).toBeNull();
    expect(parsePomodoroCommand(envelope({ type: "finish-pomodoro", outcome: "great", reflection: "" }))).toBeNull();
    const log = { type: "log-pomodoro", projectId: "P1", start: "2026-09-22T08:00", minutes: 45, intention: "Call", outcome: null, reflection: "" };
    expect(parsePomodoroCommand(envelope(log))?.command.type).toBe("log-pomodoro");
    expect(parsePomodoroCommand(envelope({ ...log, start: "2026-09-22" }))).toBeNull();
    expect(parsePomodoroCommand(envelope({ ...log, minutes: 181 }))).toBeNull();
    expect(parsePomodoroCommand(envelope({ type: "set-project-status", projectId: "P1", status: "active" }))).toBeNull();
  });

  it("places sessions on the local calendar and reports the week's Monday", () => {
    const now = new Date(2026, 8, 24, 15, 0); // Thursday, local time
    const store = finishPomodoro(
      startPomodoro(emptyPomodoroStore(), start, new Date(2026, 8, 22, 9, 5)),
      { outcome: "achieved", reflection: "" },
      new Date(2026, 8, 22, 9, 30),
    );
    const dto = elmPomodoro(store, 25, now);
    expect(dto).toMatchObject({ focusMinutes: 25, active: null, today: "2026-09-24", weekStart: "2026-09-21" });
    expect(dto.sessions[0]).toMatchObject({ day: "2026-09-22", startedTime: "09:05", endedTime: "09:30", focusedMinutes: 25, status: "completed" });
  });

  it("reports a paused session without a running start", () => {
    const paused = pausePomodoro(startPomodoro(emptyPomodoroStore(), start, at("10:00")), at("10:05"));
    expect(elmPomodoro(paused, 25, at("10:10")).active).toMatchObject({ focusedBefore: 300, resumedAtMs: null });
  });
});
