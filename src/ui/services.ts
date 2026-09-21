import type { App, TFile } from "obsidian";
import type { GtdSettings } from "../domain/types";
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
  createProject: (openAfterCreate?: boolean, parentProjectId?: string) => void;
  editAction: (id: string, allowProjectConversion?: boolean) => void;
  editProject: (id: string) => void;
  showProjectDetail: (id: string) => void;
}
