import type { App, EventRef } from "obsidian";
import {
  deleteSavedView,
  emptySavedViewStore,
  mergeSavedViewStores,
  parseSavedViewStore,
  startingSavedViews,
  upsertSavedView,
  type SavedViewStore,
} from "../domain/saved-views";
import type { SavedView } from "../domain/types";
import { SyncedJsonFile } from "./synced-json-file";

const STORE_PATH = "GTD/views.json";
/** Which view is open: this device's own, in Obsidian's per-device storage for the vault. */
const ACTIVE_VIEW_KEY = "dragonglass-active-saved-view";

/**
 * Owns the Action Board's saved views (`GTD/views.json`, shared by every device) and
 * which one is open on this device. `onChange` is called whenever either changes,
 * including when sync brings another device's views.
 */
export class SavedViewService {
  private store: SavedViewStore = emptySavedViewStore();
  private active: string | null;
  private readonly file: SyncedJsonFile<SavedViewStore>;

  constructor(
    private readonly app: App,
    private readonly onChange: () => void,
    initial: { views: SavedView[]; activeId: string | null },
  ) {
    this.store = { ...emptySavedViewStore(), views: initial.views };
    const stored = app.loadLocalStorage(ACTIVE_VIEW_KEY) as unknown;
    this.active = typeof stored === "string" ? stored : stored === null ? initial.activeId : null;
    this.file = new SyncedJsonFile(app, {
      path: () => STORE_PATH,
      parse: parseSavedViewStore,
      empty: emptySavedViewStore,
      merge: mergeSavedViewStores,
      current: () => this.store,
      replace: (next) => {
        this.store = next;
        this.onChange();
      },
    });
  }

  /**
   * Reads the shared file and adds the views this device still had in its settings
   * (`legacy`, `null` once moved), then watches the file for other devices' changes.
   * Returns the watch refs to register, and whether the file now holds this device's views.
   */
  async start(legacy: SavedView[] | null, defaults: () => SavedView[]): Promise<{ refs: EventRef[]; moved: boolean }> {
    const exists = await this.app.vault.adapter.exists(STORE_PATH);
    if (exists && !(await this.readable())) {
      // Sync is still copying it: show what this device has, write nothing over it, and
      // take the file in when the copy lands (the watch merges it in).
      this.store = startingSavedViews(null, legacy, defaults);
      this.onChange();
      return { refs: this.file.watch(), moved: false };
    }
    const file = exists ? await this.file.load() : null;
    const starting = startingSavedViews(file, legacy, defaults);
    this.store = starting;
    if (!file || starting.views.length !== file.views.length) await this.file.write(starting);
    this.onChange();
    return { refs: this.file.watch(), moved: true };
  }

  private async readable(): Promise<boolean> {
    try {
      JSON.parse(await this.app.vault.adapter.read(STORE_PATH));
      return true;
    } catch {
      return false;
    }
  }

  views(): SavedView[] {
    return this.store.views;
  }

  /** The open view on this device, if it still exists. */
  activeId(): string | null {
    return this.active && this.store.views.some((view) => view.id === this.active) ? this.active : null;
  }

  setActive(id: string | null): void {
    this.active = id;
    this.app.saveLocalStorage(ACTIVE_VIEW_KEY, id ?? "");
    this.onChange();
  }

  async upsert(view: SavedView, activate: boolean): Promise<void> {
    this.store = upsertSavedView(this.store, view);
    if (activate) this.setActive(view.id);
    else this.onChange();
    await this.file.write(this.store);
  }

  async delete(id: string): Promise<void> {
    this.store = deleteSavedView(this.store, id);
    if (this.active === id) this.setActive(null);
    else this.onChange();
    await this.file.write(this.store);
  }
}
