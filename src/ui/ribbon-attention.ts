import type { Attention } from "../domain/attention";

/**
 * Puts a dot on a ribbon icon while its view has something waiting to be done.
 * Index changes arrive in bursts, so updates are gathered for a moment first.
 */
export class RibbonAttention {
  private timer: number | null = null;

  constructor(
    private readonly icons: Partial<Record<keyof Attention, HTMLElement>>,
    private readonly read: () => Attention,
  ) {}

  schedule(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.update();
    }, 250);
  }

  update(): void {
    const state = this.read();
    for (const [key, icon] of Object.entries(this.icons) as Array<[keyof Attention, HTMLElement]>) {
      icon.toggleClass("dg-ribbon-attention", state[key]);
    }
  }

  stop(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    for (const icon of Object.values(this.icons)) icon?.removeClass("dg-ribbon-attention");
  }
}
