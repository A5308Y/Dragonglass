import type { App, TFile } from "obsidian";
import type { ActionStatus, GtdSettings, ProjectStatus } from "../domain/types";
import type { AgentService } from "../agent/agent-service";
import type { GtdRepository } from "../repository/gtd-repository";

export interface GtdServices {
  app: App;
  repository: GtdRepository;
  /** Runs delegated Project trees in the agent sandbox. */
  agent: AgentService;
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
  /** Shows what delegating a Project tree would hand over, and starts the run. */
  delegateProject: (projectId: string) => Promise<void>;
  /** Opens the Delegate dialog filled in from an earlier run, to start it again. */
  rerunAgentRun: (runId: string) => Promise<void>;
  /** Asks, then deletes an ended agent run, and its results if wanted. */
  deleteAgentRun: (runId: string) => Promise<void>;
}
