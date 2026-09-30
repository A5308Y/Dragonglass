/**
 * Plays the audio files of a vault folder one after another, each next one chosen at
 * random (never the one that just ended, when there is another), for as long as a
 * Pomodoro runs. Pausing keeps the place in the current file; stopping forgets it.
 */
export class FolderSound {
  private audio: HTMLAudioElement | null = null;
  private current = "";
  private playing = false;

  /** `files` gives the folder's playable files as resource addresses, read on every change of file. */
  constructor(private readonly files: () => string[]) {}

  /** Plays, or goes on playing, at `volume` from 0 to 1. */
  play(volume: number): void {
    const audio = this.element();
    audio.volume = Math.max(0, Math.min(1, volume));
    if (this.playing && !audio.paused) return;
    if (!this.current && !this.load()) return;
    this.playing = true;
    // Browsers refuse sound that nothing the person did started; it begins with their next action.
    void audio.play().catch(() => {
      this.playing = false;
    });
  }

  pause(): void {
    this.playing = false;
    this.audio?.pause();
  }

  /** Stops and forgets the place, so the next session starts with a fresh random file. */
  stop(): void {
    this.pause();
    this.current = "";
    if (this.audio) {
      this.audio.removeAttribute("src");
      this.audio.load();
    }
  }

  close(): void {
    this.stop();
    this.audio = null;
  }

  private element(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = "auto";
    audio.addEventListener("ended", () => {
      if (!this.playing) return;
      if (this.load()) void audio.play().catch(() => undefined);
    });
    this.audio = audio;
    return audio;
  }

  /** Takes a random file, not the one just played if there is another; false when the folder has none. */
  private load(): boolean {
    const files = this.files();
    if (!files.length) return false;
    const choices = files.length > 1 ? files.filter((file) => file !== this.current) : files;
    this.current = choices[Math.floor(Math.random() * choices.length)]!;
    this.element().src = this.current;
    return true;
  }
}
