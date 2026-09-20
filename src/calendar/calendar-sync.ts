import { requestUrl } from "obsidian";
import type { App } from "obsidian";
import type { GoogleCalendarSettings } from "../domain/types";
import type { GtdIndex } from "../repository/gtd-index";
import { buildCalendarSyncEvents } from "./events";

/** Bumped whenever the bridge payload changes, so an un-redeployed Apps Script says so plainly. */
const BRIDGE_VERSION = 2;

export interface CalendarSyncResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  calendar?: string;
}

export interface CalendarSyncStatus {
  state: "disabled" | "idle" | "syncing" | "success" | "error";
  lastSuccess?: string;
  error?: string;
  result?: CalendarSyncResult;
}

interface BridgeResponse extends Partial<CalendarSyncResult> {
  ok?: boolean;
  error?: string;
}

export type CalendarBridgeRequest = (request: {
  url: string;
  method: string;
  contentType: string;
  body: string;
  throw: boolean;
}) => Promise<{ status: number; json: unknown; text?: string }>;

export class GoogleCalendarSync {
  private status: CalendarSyncStatus = { state: "disabled" };
  private listeners = new Set<() => void>();
  private timeout: number | null = null;
  private active: Promise<CalendarSyncResult> | null = null;
  private rerun = false;

  constructor(
    private readonly app: App,
    private readonly index: GtdIndex,
    private readonly getSettings: () => GoogleCalendarSettings,
    private readonly request: CalendarBridgeRequest = requestUrl,
  ) {}

  start(): () => void {
    this.status = { state: this.getSettings().enabled ? "idle" : "disabled" };
    const unsubscribe = this.index.subscribe(() => this.schedule());
    this.schedule(3_000);
    return () => {
      unsubscribe();
      if (this.timeout !== null) window.clearTimeout(this.timeout);
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): CalendarSyncStatus {
    return this.status;
  }

  schedule(delay = 1_500): void {
    if (!this.getSettings().enabled) {
      this.setStatus({ state: "disabled" });
      return;
    }
    if (this.timeout !== null) window.clearTimeout(this.timeout);
    this.timeout = window.setTimeout(() => {
      this.timeout = null;
      void this.syncNow().catch(() => undefined);
    }, delay);
  }

  async testConnection(): Promise<CalendarSyncResult> {
    const settings = this.requireConfiguration(false);
    return this.callBridge(settings, { version: BRIDGE_VERSION, operation: "test", secret: settings.sharedSecret, sourceId: settings.sourceId });
  }

  async syncNow(): Promise<CalendarSyncResult> {
    if (this.active) {
      this.rerun = true;
      return this.active;
    }
    let settings: GoogleCalendarSettings;
    try {
      settings = this.requireConfiguration(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google Calendar is not configured.";
      this.setStatus({ state: "error", error: message });
      throw error;
    }
    const { error: _previousError, ...previousStatus } = this.status;
    this.setStatus({ ...previousStatus, state: "syncing" });
    const events = buildCalendarSyncEvents(this.index.getSnapshot(), this.app.vault.getName());
    const run = this.callBridge(settings, {
      version: BRIDGE_VERSION,
      operation: "reconcile",
      secret: settings.sharedSecret,
      sourceId: settings.sourceId,
      events,
    }).then((result) => {
      this.setStatus({ state: "success", lastSuccess: new Date().toISOString(), result });
      return result;
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Google Calendar sync failed.";
      this.setStatus({ ...this.status, state: "error", error: message });
      throw error;
    }).finally(() => {
      this.active = null;
      if (this.rerun) {
        this.rerun = false;
        this.schedule(0);
      }
    });
    this.active = run;
    return run;
  }

  private requireConfiguration(requireEnabled: boolean): GoogleCalendarSettings {
    const settings = this.getSettings();
    if (requireEnabled && !settings.enabled) throw new Error("Google Calendar integration is disabled.");
    if (!settings.endpointUrl.trim() || !settings.sharedSecret.trim()) {
      throw new Error("Configure the Apps Script URL and shared secret first.");
    }
    let endpoint: URL;
    try {
      endpoint = new URL(settings.endpointUrl.trim());
    } catch {
      throw new Error("The Apps Script URL is invalid.");
    }
    if (endpoint.protocol !== "https:") throw new Error("The Apps Script URL must use HTTPS.");
    if (endpoint.hostname !== "script.google.com" || !endpoint.pathname.includes("/macros/") || !/\/exec\/?$/.test(endpoint.pathname)) {
      throw new Error("Use the deployed Apps Script web-app URL ending in /exec, not the editor, project, or /dev URL.");
    }
    return settings;
  }

  private async callBridge(settings: GoogleCalendarSettings, body: Record<string, unknown>): Promise<CalendarSyncResult> {
    const response = await this.request({
      url: settings.endpointUrl.trim(),
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(body),
      throw: false,
    });
    let payload: BridgeResponse;
    try {
      payload = response.json as BridgeResponse;
    } catch {
      if (response.status === 404 || /not found/i.test(response.text ?? "")) {
        throw new Error("Apps Script deployment not found. Check the /exec deployment URL and that the web app is deployed for Anyone.");
      }
      throw new Error(`Calendar bridge returned an unreadable response (${response.status}). Check the deployment URL and web-app access.`);
    }
    if (response.status < 200 || response.status >= 300 || payload.ok !== true) {
      if (response.status === 404) {
        throw new Error("Apps Script deployment not found. Check the /exec deployment URL and that the web app is deployed for Anyone.");
      }
      throw new Error(payload.error || `Calendar bridge request failed (${response.status}).`);
    }
    return {
      created: finiteCount(payload.created),
      updated: finiteCount(payload.updated),
      deleted: finiteCount(payload.deleted),
      unchanged: finiteCount(payload.unchanged),
      ...(typeof payload.calendar === "string" ? { calendar: payload.calendar } : {}),
    };
  }

  private setStatus(status: CalendarSyncStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
