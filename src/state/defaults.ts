import type { GtdSettings, SavedView } from "../domain/types";

const DEFAULT_SORT = { field: "created", direction: "desc" } as const;

export function createDefaultViews(): SavedView[] {
  return [
    {
      id: "default-next",
      name: "Next Actions",
      filters: [
        { kind: "value", field: "status", operator: "in", values: ["next"] },
        { kind: "availability", operator: "available" },
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
    defaultActionStatus: "next",
    showDoneColumn: true,
    projectBoardColumns: ["active", "backlog", "someday", "completed"],
    savedViews: createDefaultViews(),
    activeSavedViewId: null,
    googleCalendar: {
      enabled: false,
      endpointUrl: "",
      sharedSecret: "",
      sourceId: "",
      defaultDurationMinutes: 30,
    },
    feeds: {
      enabled: false,
      storePath: "GTD/feeds.json",
      refreshMinutes: 30,
    },
    schemaVersion: 10,
  };
}
