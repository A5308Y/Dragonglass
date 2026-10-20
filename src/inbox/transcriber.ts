import type { App, TFile } from "obsidian";
import type * as ChildProcess from "node:child_process";
import type * as FsPromises from "node:fs/promises";
import type * as NodeOs from "node:os";
import type * as NodePath from "node:path";
import {
  HOMEBREW_BIN,
  cleanTranscript,
  ffmpegArgs,
  isAudioExtension,
  whisperArgs,
  type TranscriptionSettings,
} from "../domain/transcription";

interface NodeModules {
  fs: typeof FsPromises;
  path: typeof NodePath;
  os: typeof NodeOs;
  child: typeof ChildProcess;
}

/** A long memo takes whisper.cpp a while; one that takes longer than this is stuck. */
const WHISPER_TIMEOUT_MS = 20 * 60_000;
const FFMPEG_TIMEOUT_MS = 2 * 60_000;

/**
 * Transcribes voice memos with whisper.cpp on this Mac (see `src/domain/transcription.ts`).
 * One at a time: whisper.cpp uses every core it gets, and a second memo would only wait.
 */
export class Transcriber {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly app: App, private readonly getSettings: () => TranscriptionSettings) {}

  /** Whether this device can transcribe: the desktop app, with a model chosen. */
  available(desktop: boolean): boolean {
    return desktop && Boolean(this.getSettings().modelPath);
  }

  transcribe(file: TFile): Promise<string> {
    const done = this.queue.then(() => this.transcribeNow(file));
    this.queue = done.catch(() => undefined);
    return done;
  }

  private async transcribeNow(file: TFile): Promise<string> {
    const node = nodeModules();
    if (!node) throw new Error("Transcribing needs the desktop app.");
    if (!isAudioExtension(file.extension)) throw new Error("This Inbox Item isn't a recording.");
    const settings = this.getSettings();
    const model = expandHome(node, settings.modelPath);
    if (!model) throw new Error("Choose a whisper.cpp model in Dragonglass's settings first (Transcribing voice memos).");
    try {
      await node.fs.access(model);
    } catch {
      throw new Error(`The whisper.cpp model isn't at ${model}.`);
    }
    const whisper = await program(node, settings.whisperPath, "whisper-cli", "brew install whisper-cpp");
    const ffmpeg = await program(node, settings.ffmpegPath, "ffmpeg", "brew install ffmpeg");

    const folder = await node.fs.mkdtemp(node.path.join(node.os.tmpdir(), "dragonglass-transcribe-"));
    try {
      const input = node.path.join(folder, `memo.${file.extension}`);
      const wav = node.path.join(folder, "memo.wav");
      await node.fs.writeFile(input, new Uint8Array(await this.app.vault.readBinary(file)));
      await run(node, ffmpeg, ffmpegArgs(input, wav), FFMPEG_TIMEOUT_MS, "ffmpeg couldn't read the recording");
      const transcript = cleanTranscript(await run(node, whisper, whisperArgs(model, wav, settings.language), WHISPER_TIMEOUT_MS, "whisper.cpp failed"));
      if (!transcript) throw new Error("whisper.cpp heard no speech in this recording.");
      return transcript;
    } finally {
      await node.fs.rm(folder, { recursive: true, force: true });
    }
  }
}

function nodeModules(): NodeModules | null {
  const required = (globalThis as Record<string, unknown>).require;
  if (typeof required !== "function") return null;
  const load = required as (id: string) => unknown;
  return {
    fs: load("fs/promises") as typeof FsPromises,
    path: load("path") as typeof NodePath,
    os: load("os") as typeof NodeOs,
    child: load("child_process") as typeof ChildProcess,
  };
}

function expandHome(node: NodeModules, path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("~/") ? node.path.join(node.os.homedir(), trimmed.slice(2)) : trimmed;
}

/** The program as set, or else where Homebrew puts it; Obsidian doesn't get the shell's PATH. */
async function program(node: NodeModules, configured: string, name: string, install: string): Promise<string> {
  const candidates = configured.trim() ? [expandHome(node, configured)] : HOMEBREW_BIN.map((folder) => node.path.join(folder, name));
  for (const candidate of candidates) {
    try {
      await node.fs.access(candidate);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  throw new Error(configured.trim() ? `${name} isn't at ${configured.trim()}.` : `${name} wasn't found. Install it with “${install}”.`);
}

function run(node: NodeModules, file: string, args: string[], timeout: number, failure: string): Promise<string> {
  return new Promise((resolve, reject) => {
    node.child.execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve(String(stdout));
        return;
      }
      const detail = String(stderr).trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
      reject(new Error(error.killed ? `${failure}: it took too long.` : `${failure}${detail ? `: ${detail}` : "."}`));
    });
  });
}
