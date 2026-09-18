import type { App, TFile } from "obsidian";
import type { GtdSettings, InboxItem } from "../domain/types";
import type { GtdRepository } from "../repository/gtd-repository";

export interface GtdServices {
  app: App;
  repository: GtdRepository;
  getSettings: () => GtdSettings;
  saveSettings: (settings: GtdSettings) => Promise<void>;
  openFile: (file: TFile) => Promise<void>;
  quickCapture: () => void;
  openInbox: () => void;
  processInboxItem: (item: InboxItem) => void;
  createProject: (openAfterCreate?: boolean) => void;
  editAction: (id: string) => void;
  editProject: (id: string) => void;
  showProjectDetail: (id: string) => void;
}
