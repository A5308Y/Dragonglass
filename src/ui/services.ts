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
  createAction: (projectId?: string) => void;
  importActions: (projectId?: string) => void;
  createProject: (openAfterCreate?: boolean, parentProjectId?: string) => void;
  editAction: (id: string, allowProjectConversion?: boolean) => void;
  editProject: (id: string) => void;
  showProjectDetail: (id: string) => void;
}
