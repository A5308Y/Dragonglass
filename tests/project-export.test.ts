import type { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { actionDetails, countTree, exportTree, projectExportHtml, type ExportedProject } from "../src/domain/project-export";
import type { Action, Project } from "../src/domain/types";

const project = (id: string, changes: Partial<Project> = {}): Project => ({
  type: "gtd-project", id, title: id, file: { path: `${id}.md` } as TFile, status: "active", created: "2026-09-01", ...changes,
});
const action = (id: string, projectId: string, changes: Partial<Action> = {}): Action => ({
  type: "gtd-action", id, title: id, file: { path: `${id}.md` } as TFile, status: "next", created: "2026-09-01", projectId, ...changes,
});

describe("Exporting a Project tree", () => {
  const projects = [
    project("House"),
    project("Roof", { parentProjectId: "House", order: 2 }),
    project("Garden", { parentProjectId: "House", order: 1 }),
    project("Shed", { parentProjectId: "Garden" }),
    project("Old plan", { parentProjectId: "House", status: "cancelled" }),
    project("Windows", { parentProjectId: "House", status: "completed" }),
    project("Elsewhere"),
  ];
  const actions = [
    action("Call roofer", "Roof", { status: "waiting", delegatedTo: "ben@example.com" }),
    action("Buy tiles", "Roof", { priority: 1 }),
    action("Paid deposit", "Roof", { status: "done" }),
    action("Dropped", "Roof", { status: "cancelled" }),
    action("Not ours", "Elsewhere"),
  ];

  it("takes the tree below the Project, in board order, without what was let go or finished", () => {
    const tree = exportTree("House", projects, actions, { includeDone: false });
    expect(tree.children.map((child) => child.project.id)).toEqual(["Garden", "Roof"]);
    expect(tree.children[0]!.children.map((child) => child.project.id)).toEqual(["Shed"]);
    expect(tree.children[1]!.actions.map((entry) => entry.id)).toEqual(["Buy tiles", "Call roofer"]);
    expect(countTree(tree)).toEqual({ projects: 4, actions: 2 });
  });

  it("adds done Actions and Completed sub-projects when asked, but never cancelled ones", () => {
    const tree = exportTree("House", projects, actions, { includeDone: true });
    expect(tree.children.map((child) => child.project.id)).toEqual(["Garden", "Roof", "Windows"]);
    expect(tree.children[1]!.actions.map((entry) => entry.id)).toEqual(["Buy tiles", "Call roofer", "Paid deposit"]);
  });

  it("says who a Waiting Action waits for", () => {
    expect(actionDetails(action("a", "p", { status: "waiting", delegatedTo: "ben@example.com", waitingSince: "2026-10-01" })))
      .toEqual(["Waiting for ben@example.com", "since 2026-10-01"]);
  });

  it("escapes everything typed in the vault and keeps the cleaned note markup", () => {
    const page: ExportedProject = {
      title: "Bath <script>alert(1)</script> [[Room|room]]",
      status: "active",
      purposeHtml: "<p>Less mould</p>",
      desiredOutcomeHtml: "",
      actions: [action("<b>Call</b> & ask", "p")],
      notes: [{ title: "Quotes \"2026\"", html: "<ul><li>One</li></ul>" }],
      children: [],
    };
    const html = projectExportHtml(page, "4 October 2026");
    expect(html).toContain("<title>Bath &#60;script&#62;alert(1)&#60;/script&#62; room</title>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;b&#62;Call&#60;/b&#62; &#38; ask");
    expect(html).toContain("<div class=\"text\"><p>Less mould</p></div>");
    expect(html).not.toContain("Desired outcome");
    expect(html).toContain("Note: Quotes &#34;2026&#34;");
    expect(html).toContain("A read-only copy from 4 October 2026. It does not update.");
  });
});
