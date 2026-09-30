import { Notice, normalizePath, type App } from "obsidian";
import {
  discardPomodoro,
  emptyPomodoroStore,
  mergePomodoroStores,
  endsAt,
  finishPomodoro,
  parsePomodoroStore,
  pausePomodoro,
  recordCompletedAction,
  remainingSeconds,
  restorePomodoro,
  resumePomodoro,
  startPomodoro,
  type PomodoroSession,
  type PomodoroStart,
  type PomodoroStore,
  type PomodoroWrapUp,
} from "../domain/pomodoro";
import type { PomodoroSettings } from "../domain/types";
import { withExternalLink } from "../domain/mite";
import { SyncedJsonFile } from "../state/synced-json-file";
import { showUndoNotice } from "../ui/undo";
import { TickSound } from "./tick-sound";
import { FolderSound } from "./folder-sound";
import { isPathInDirectory } from "../utils/path";

/**
 * Owns the running Pomodoro and the session log.
 *
 * The session lives here rather than in a view, so it keeps running when the
 * Pomodoro view is closed and survives a restart: the store file records when the
 * current stretch began, and time is always derived from that, never counted.
 */
const SOUND_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "flac"]);

export class PomodoroService {
  private store: PomodoroStore = emptyPomodoroStore();
  private loaded = false;
  /** The store file, merged with other devices' changes on every write and on sync. */
  private readonly file: SyncedJsonFile<PomodoroStore>;
  private listeners = new Set<() => void>();
  private alarm: number | null = null;
  private ticker: number | null = null;
  private statusBar: HTMLElement | null = null;
  private readonly tick = new TickSound();
  private readonly folder = new FolderSound(() => this.soundFiles());

  constructor(
    private readonly app: App,
    private readonly getSettings: () => PomodoroSettings,
    private readonly onFinished: (session: PomodoroSession) => Promise<void>,
    private readonly onOpen: () => void,
  ) {
    this.file = new SyncedJsonFile(app, {
      path: () => this.storePath(),
      parse: parsePomodoroStore,
      empty: emptyPomodoroStore,
      merge: mergePomodoroStores,
      current: () => this.store,
      replace: (next) => {
        this.store = next;
        this.arm();
        this.notify();
      },
    });
  }

  start(statusBar: HTMLElement): () => void {
    this.statusBar = statusBar;
    statusBar.addClass("dg-pomodoro-status", "mod-clickable");
    statusBar.addEventListener("click", () => this.onOpen());
    // A session started, paused or finished on another device shows up here too.
    const watching = this.file.watch();
    void this.load();
    return () => {
      this.clearTimers();
      this.tick.close();
      this.folder.close();
      this.statusBar = null;
      for (const ref of watching) this.app.vault.offref(ref);
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStore(): PomodoroStore {
    return this.store;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    // No log yet, or one that is no longer readable, gives a fresh one.
    this.store = await this.file.load();
    this.arm();
    this.notify();
  }

  async begin(start: PomodoroStart): Promise<void> {
    // Sound may only start from something the person did: starting a session is that.
    this.prepareSound();
    await this.load();
    await this.update(startPomodoro(this.store, start, new Date()));
  }

  async pause(): Promise<void> {
    await this.update(pausePomodoro(this.store, new Date()));
  }

  async resume(): Promise<void> {
    this.prepareSound();
    await this.update(resumePomodoro(this.store, new Date()));
  }

  async recordAction(actionId: string): Promise<void> {
    await this.update(recordCompletedAction(this.store, actionId));
  }

  async finish(wrapUp: PomodoroWrapUp): Promise<void> {
    const next = finishPomodoro(this.store, wrapUp, new Date());
    await this.update(next);
    await this.onFinished(next.sessions[0]!);
  }

  /** Throws the running session away, with Undo, since it was never filed. */
  async discard(): Promise<void> {
    const active = this.store.active;
    if (!active) return;
    await this.update(discardPomodoro(this.store));
    showUndoNotice(`Discarded the Pomodoro for “${active.projectTitle}”.`, () => this.update(restorePomodoro(this.store, active)));
  }

  /** Records what a finished session became in a time tracker, so it isn't sent twice. */
  async recordExternal(sessionId: string, integration: string, id: string): Promise<void> {
    await this.update(withExternalLink(this.store, sessionId, integration, id, new Date().toISOString()));
  }

  private async update(next: PomodoroStore): Promise<void> {
    this.store = next;
    this.arm();
    this.notify();
    await this.persist();
  }

  /** Re-arms the time-up alarm and the status bar ticker for whatever is running now. */
  private arm(): void {
    this.clearTimers();
    const active = this.store.active;
    const end = active ? endsAt(active, new Date()) : null;
    if (active && end) {
      const delay = end.getTime() - Date.now();
      if (delay > 0) {
        this.alarm = window.setTimeout(() => {
          this.alarm = null;
          new Notice(`Pomodoro finished: “${active.intention}”. Time to wrap up.`, 10_000);
          this.syncSound();
          this.renderStatus();
          this.notify();
        }, delay);
      }
      this.ticker = window.setInterval(() => {
        this.renderStatus();
        this.playTick();
      }, 1_000);
    }
    this.syncSound();
    this.renderStatus();
  }

  /**
   * The sound setting changed: the new one starts, or the old one stops, at once. Called
   * from what the person did (the timer's selector, the settings), so sound may start.
   */
  soundChanged(): void {
    this.prepareSound();
    this.syncSound();
  }

  private prepareSound(): void {
    if (this.getSettings().sound === "ticking") this.tick.prepare();
  }

  /** Whether the session is running right now, not paused and not past its time. */
  private running(): boolean {
    const active = this.store.active;
    return Boolean(active?.resumedAt) && remainingSeconds(active!, new Date()) > 0;
  }

  private playTick(): void {
    const settings = this.getSettings();
    if (settings.sound === "ticking" && this.running()) this.tick.play(settings.soundVolume / 100);
  }

  /** The folder's sound plays while the session runs, pauses with it, and stops at its end. */
  private syncSound(): void {
    const settings = this.getSettings();
    const paused = Boolean(this.store.active) && !this.store.active!.resumedAt;
    if (settings.sound === "folder" && this.running()) this.folder.play(settings.soundVolume / 100);
    // Paused keeps the place in the file; anything else (finished, time up, another sound) ends it.
    else if (settings.sound === "folder" && paused) this.folder.pause();
    else this.folder.stop();
    if (!(settings.sound === "ticking" && this.running())) this.tick.suspend();
  }

  /** The sound folder's audio files, as addresses the player can load. */
  private soundFiles(): string[] {
    const folder = this.getSettings().soundFolder;
    return this.app.vault.getFiles()
      .filter((file) => SOUND_EXTENSIONS.has(file.extension.toLowerCase()) && isPathInDirectory(file.path, folder))
      .map((file) => this.app.vault.getResourcePath(file));
  }

  private renderStatus(): void {
    const bar = this.statusBar;
    if (!bar) return;
    const active = this.store.active;
    if (!active) {
      bar.setText("");
      bar.hide();
      return;
    }
    const remaining = remainingSeconds(active, new Date());
    const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
    const state = remaining <= 0 ? "wrap up" : active.resumedAt ? clock : `${clock} paused`;
    bar.setText(`🍅 ${state} · ${active.projectTitle}`);
    bar.show();
    if (remaining <= 0 && this.ticker !== null) {
      window.clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private clearTimers(): void {
    if (this.alarm !== null) window.clearTimeout(this.alarm);
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.alarm = null;
    this.ticker = null;
  }

  private storePath(): string {
    return normalizePath(this.getSettings().storePath.trim() || "GTD/pomodoros.json");
  }

  /** Merged with the file first, so sessions filed on another device are kept. */
  private persist(): Promise<void> {
    return this.file.write(this.store);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
