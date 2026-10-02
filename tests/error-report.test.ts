import { describe, expect, it } from "vitest";
import { ERROR_REPORT_LIMIT, describeErrors, errorDetails, isOwnError, recordError } from "../src/domain/error-report";

const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'childNodes')",
  "    at _VirtualDom_addDomNodesHelp (plugin:dragonglass-gtd:8467:32)",
  "    at _VirtualDom_addDomNodes (plugin:dragonglass-gtd:8422:7)",
].join("\n");
const MESSAGE = "Cannot read properties of undefined (reading 'childNodes')";

describe("Error reports", () => {
  it("recognises errors thrown by this plugin's code", () => {
    expect(isOwnError("dragonglass-gtd", "plugin:dragonglass-gtd", "")).toBe(true);
    expect(isOwnError("dragonglass-gtd", "", STACK)).toBe(true);
    expect(isOwnError("dragonglass-gtd", "app.js", "    at x (app://obsidian.md/app.js:1:2)")).toBe(false);
    // Another plugin whose id starts the same way is not ours.
    expect(isOwnError("dragonglass-gtd", "", "    at x (plugin:dragonglass-gtd-extra:1:2)")).toBe(false);
  });

  it("counts repeats of one fault on one report", () => {
    let reports = recordError([], MESSAGE, STACK, "2026-10-02T10:00:00.000Z");
    for (let i = 0; i < 733; i += 1) reports = recordError(reports, MESSAGE, STACK, "2026-10-02T10:00:12.000Z");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ count: 734, first: "2026-10-02T10:00:00.000Z", last: "2026-10-02T10:00:12.000Z" });
    expect(describeErrors(reports)).toContain("(734 times)");
  });

  it("keeps different errors apart, newest first, up to the limit", () => {
    let reports = recordError([], MESSAGE, STACK, "t1");
    reports = recordError(reports, "Other", "    at y (plugin:dragonglass-gtd:1:1)", "t2");
    expect(reports.map((report) => report.message)).toEqual(["Other", MESSAGE]);
    expect(describeErrors(reports)).toContain("and 1 other error:");
    // A repeat of the older error makes it the latest again.
    reports = recordError(reports, MESSAGE, STACK, "t3");
    expect(reports.map((report) => [report.message, report.count])).toEqual([[MESSAGE, 2], ["Other", 1]]);
    for (let i = 0; i < 10; i += 1) reports = recordError(reports, `E${i}`, "", "t3");
    expect(reports).toHaveLength(ERROR_REPORT_LIMIT);
  });

  it("gives the details for a bug report", () => {
    const details = errorDetails(recordError([], MESSAGE, STACK, "t1"));
    expect(details).toContain("1×, first t1");
    expect(details).toContain("_VirtualDom_addDomNodesHelp");
  });

  it("says nothing without errors", () => {
    expect(describeErrors([])).toBe("");
  });
});
