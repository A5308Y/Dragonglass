import type { Project } from "./types";
import { localDate } from "../utils/date";

/** Someday/Maybe Projects whose local activation day has arrived. */
export function projectsDueForActivation(projects: readonly Project[], today = localDate()): Project[] {
  return projects.filter((project) =>
    project.status === "someday"
    && Boolean(project.activateAt)
    && project.activateAt! <= today
  );
}
