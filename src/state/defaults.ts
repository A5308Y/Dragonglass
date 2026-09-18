import type { GtdSettings, SavedView } from "../domain/types";

const DEFAULT_SORT = { field: "created", direction: "desc" } as const;

export function createDefaultViews(): SavedView[] {
  return [
    {
      id: "default-inbox",
      name: "Inbox",
      filters: [{ kind: "value", field: "status", operator: "in", values: ["inbox"] }],
      groupBy: "status",
      sort: DEFAULT_SORT,
      visibleColumns: ["inbox"],
    },
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
      id: "default-someday",
      name: "Someday",
      filters: [{ kind: "value", field: "status", operator: "in", values: ["someday"] }],
      groupBy: "status",
      sort: DEFAULT_SORT,
      visibleColumns: ["someday"],
    },
    {
      id: "default-all-open",
      name: "All Open",
      filters: [{ kind: "value", field: "status", operator: "notIn", values: ["done", "cancelled"] }],
      groupBy: "status",
      sort: DEFAULT_SORT,
      visibleColumns: ["inbox", "next", "waiting", "scheduled", "someday"],
    },
  ];
}

export function defaultSettings(): GtdSettings {
  return {
    projectsDirectory: "GTD/Projects",
    actionsDirectory: "GTD/Actions",
    defaultActionStatus: "inbox",
    showDoneColumn: true,
    savedViews: createDefaultViews(),
    activeSavedViewId: null,
    schemaVersion: 1,
  };
}
