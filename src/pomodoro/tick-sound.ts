/**
 * The ticking of a mechanical kitchen timer, made with the Web Audio API rather than
 * shipped as a sound file: a few milliseconds of noise through a narrow band-pass
 * filter, with "tick" and "tock" a little apart in pitch. Soft, so it keeps time in
 * the background rather than asking for attention.
 */
export class TickSound {
  private context: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private tock = false;

  /**
   * Readies the audio output. Browsers only let sound start after the person did
   * something, so this is called when a session starts or the ticking is switched on.
   */
  prepare(): void {
    const context = this.audio();
    if (context?.state === "suspended") void context.resume().catch(() => undefined);
  }

  /** One tick; `volume` runs from 0 to 1. Quietly does nothing where audio isn't available. */
  play(volume: number): void {
    const context = this.audio();
    if (!context || !this.noise || volume <= 0) return;
    if (context.state === "suspended") {
      void context.resume().catch(() => undefined);
      return;
    }
    const at = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = this.noise;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = this.tock ? 2_300 : 3_000;
    filter.Q.value = 7;
    const gain = context.createGain();
    gain.gain.setValueAtTime(Math.min(1, volume) * 0.6, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(at);
    source.stop(at + 0.04);
    this.tock = !this.tock;
  }

  close(): void {
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.noise = null;
  }

  private audio(): AudioContext | null {
    if (this.context) return this.context;
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    this.context = new Context();
    const length = Math.ceil(this.context.sampleRate * 0.04);
    this.noise = this.context.createBuffer(1, length, this.context.sampleRate);
    const samples = this.noise.getChannelData(0);
    for (let index = 0; index < length; index += 1) samples[index] = Math.random() * 2 - 1;
    return this.context;
  }
}
