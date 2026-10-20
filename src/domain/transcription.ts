/**
 * Transcribing a voice memo while processing the Inbox, with whisper.cpp on this Mac.
 *
 * The transcript is only shown: it lives in the processor until the view closes and is
 * never written to the vault. The recording is copied to a temporary folder, converted by
 * ffmpeg to what whisper.cpp reads (16 kHz mono WAV) and transcribed there; nothing leaves
 * the Mac.
 */

export interface TranscriptionSettings {
  /** The whisper.cpp model file (`ggml-….bin`); empty switches transcribing off. */
  modelPath: string;
  /** A language code such as `de` or `en`, or `auto` to let whisper.cpp detect it. */
  language: string;
  /** The `whisper-cli` program; empty looks in Homebrew's folders. */
  whisperPath: string;
  /** The `ffmpeg` program; empty looks in Homebrew's folders. */
  ffmpegPath: string;
}

export const DEFAULT_TRANSCRIPTION: TranscriptionSettings = { modelPath: "", language: "auto", whisperPath: "", ffmpegPath: "" };

/** Where Homebrew puts the programs, on Apple silicon and on Intel Macs. */
export const HOMEBREW_BIN = ["/opt/homebrew/bin", "/usr/local/bin"];

export const AUDIO_EXTENSIONS = ["3gp", "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "webm"];

export function isAudioExtension(extension: string): boolean {
  return AUDIO_EXTENSIONS.includes(extension.toLowerCase());
}

export function parseTranscriptionSettings(value: unknown): TranscriptionSettings {
  const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (key: keyof TranscriptionSettings) => typeof saved[key] === "string" ? (saved[key] as string).trim() : DEFAULT_TRANSCRIPTION[key];
  return {
    modelPath: text("modelPath"),
    language: languageCode(text("language")),
    whisperPath: text("whisperPath"),
    ffmpegPath: text("ffmpegPath"),
  };
}

/** A language code whisper.cpp takes: two or three letters, or `auto`. */
export function languageCode(value: string): string {
  const code = value.trim().toLowerCase();
  return /^[a-z]{2,3}$/.test(code) ? code : "auto";
}

/** ffmpeg's arguments: any audio in, the 16 kHz mono 16-bit WAV whisper.cpp reads out. */
export function ffmpegArgs(input: string, output: string): string[] {
  return ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output];
}

/**
 * whisper-cli's arguments: the text alone on its output, without timestamps. Its loading
 * messages go to the error output, which names the reason when it fails.
 */
export function whisperArgs(model: string, wav: string, language: string): string[] {
  return ["-m", model, "-f", wav, "-l", languageCode(language), "-nt"];
}

/**
 * What is wrong with a model file, judged from its size and first bytes, or null when it
 * looks like a whisper.cpp model: those start with the magic number "ggml", which is
 * stored with its bytes reversed ("lmgg").
 */
export function modelFileProblem(size: number, head: Uint8Array): string | null {
  const start = String.fromCharCode(...head.slice(0, 32));
  if (start.startsWith("lmgg")) return null;
  const amount = size >= 1024 * 1024 ? `${Math.round(size / 1024 / 1024)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
  if (/^\s*</.test(start)) return `The model file (${amount}) is a web page, not the model: download the file itself with Hugging Face's download button.`;
  if (start.startsWith("version https://git-lfs")) return `The model file (${amount}) is only a Git LFS pointer, not the model: download the file itself.`;
  if (start.startsWith("GGUF")) return `The model file (${amount}) is a GGUF model, which whisper.cpp can't read: choose a ggml-….bin file.`;
  return `The model file (${amount}) isn't a whisper.cpp model: it doesn't start like one. Choose a ggml-….bin file from huggingface.co/ggerganov/whisper.cpp.`;
}

/** Plain words for whisper.cpp failures with a known cause, from its error output. */
export function whisperProblem(errors: string): string | null {
  if (/bad magic|invalid model data/i.test(errors)) {
    return "The model file isn't a whisper.cpp model. Download a ggml-….bin file again (the whole file, often over 1 GB) "
      + "and choose it in the settings.";
  }
  if (/failed to read audio|failed to open/i.test(errors)) return "whisper.cpp couldn't read the converted recording.";
  return null;
}

/**
 * The transcript as whisper.cpp printed it, as running text: its segments joined, and its
 * markers for silence or sounds (`[BLANK_AUDIO]`, `(music)`) left out.
 */
export function cleanTranscript(output: string): string {
  return output
    .split("\n")
    .map((line) => line.replace(/\[[A-Z_ ]+\]|\((?:music|applause|laughter|silence|noise)\)/gi, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
