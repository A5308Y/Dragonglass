import type { App, TFile } from "obsidian";
import type { ActionStatus, GtdSettings, ProjectStatus } from "../domain/types";
import type { GtdRepository } from "../repository/gtd-repository";

export interface GtdServices {
  app: App;
  repository: GtdRepository;
  getSettings: () => GtdSettings;
  saveSettings: (settings: GtdSettings, refreshViews?: boolean) => Promise<void>;
  openFile: (file: TFile) => Promise<void>;
  quickCapture: () => void;
  openInbox: () => void;
  /** Asks for one line of text, resolving to `""` when the prompt is dismissed. */
  promptForText: (title: string, placeholder: string) => Promise<string>;
  createAction: (projectId?: string) => void;
  scheduleAction: (id: string) => void;
  importActions: (projectId?: string) => void;
  importSubprojects: (parentProjectId?: string) => void;
  createProject: (openAfterCreate?: boolean, parentProjectId?: string, status?: ProjectStatus) => void;
  /** `status` opens the editor with that status already chosen, for a move that needs more first. */
  editAction: (id: string, allowProjectConversion?: boolean, status?: ActionStatus) => void;
  editProject: (id: string) => void;
  showProjectDetail: (id: string) => void;
  openSomedayReview: () => void;
  /** Opens the Pomodoro view, with this Project chosen when no session is running. */
  openPomodoro: (projectId?: string) => void;
}
