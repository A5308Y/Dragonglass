import { DEFAULT_WEEKLY_REVIEW_DAY } from "../domain/weekly-review";
import { BOARD_PROJECT_STATUSES } from "../domain/types";
import type { GtdSettings, SavedView } from "../domain/types";

const DEFAULT_SORT = { field: "created", direction: "desc" } as const;

export function createDefaultViews(): SavedView[] {
  return [
    {
      id: "default-next",
      name: "Next Actions",
      filters: [
        { kind: "value", field: "status", operator: "in", values: ["next"] },
      ],
      groupBy: "status",
      sort: { field: "due", direction: "asc" },
      visibleColumns: ["next"],
    },
    {
      id: "default-waiting",
      name: "Waiting For",
      filters: [{ kind: "value", field: "status", operator: "in", values: ["waiting"] }],
      groupBy: "status",
      sort: DEFAULT_SORT,
      visibleColumns: ["waiting"],
    },
    {
      id: "default-due-soon",
      name: "Due Soon",
      filters: [
        { kind: "value", field: "status", operator: "notIn", values: ["done", "cancelled"] },
        { kind: "due", operator: "withinNextDays", value: 7 },
      ],
      groupBy: "status",
      sort: { field: "due", direction: "asc" },
      visibleColumns: null,
    },
    {
      id: "default-all-open",
      name: "All Open",
      filters: [{ kind: "value", field: "status", operator: "notIn", values: ["done", "cancelled"] }],
      groupBy: "status",
      sort: DEFAULT_SORT,
      visibleColumns: ["next", "waiting", "scheduled"],
    },
  ];
}

export function defaultSettings(): GtdSettings {
  return {
    inboxDirectory: "GTD/Inbox",
    referenceDirectory: "General Reference",
    projectsDirectory: "GTD/Projects",
    actionsDirectory: "GTD/Actions",
    defaultProjectImage: "",
    showProjectBoardImages: true,
    projectBoardColumnsBy: "status",
    projectBoardSections: "none",
    defaultActionStatus: "next",
    showDoneColumn: true,
    projectBoardColumns: [...BOARD_PROJECT_STATUSES],
    savedViews: createDefaultViews(),
    activeSavedViewId: null,
    weeklyReviewDay: DEFAULT_WEEKLY_REVIEW_DAY,
    lastWeeklyReview: "",
    googleCalendar: {
      enabled: false,
      endpointUrl: "",
      sharedSecret: "",
      sourceId: "",
      defaultDurationMinutes: 30,
    },
    pomodoro: {
      storePath: "GTD/pomodoros.json",
      focusMinutes: 25,
      logToDiary: false,
    },
    agent: {
      runsDirectory: "",
      kitDirectory: "",
      dockerPath: "",
      keychainService: "dragonglass-agent",
      defaultBudgetUsd: 5,
      model: "claude-opus-5-5",
      localModel: "",
      localModelUrl: "http://host.docker.internal:1234",
      localKeychainService: "",
      localMaxMinutes: 120,
    },
    feeds: {
      enabled: false,
      storePath: "GTD/feeds.json",
      refreshMinutes: 30,
    },
    mail: {
      enabled: false,
      storePath: "GTD/mail.json",
      refreshMinutes: 30,
      importCap: 50,
      accounts: [],
      passwords: {},
    },
    schemaVersion: 11,
  };
}
