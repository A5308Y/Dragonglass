import { describe, expect, it } from "vitest";
import {
  cleanTranscript,
  ffmpegArgs,
  isAudioExtension,
  languageCode,
  parseTranscriptionSettings,
  whisperArgs,
  whisperProblem,
  modelFileProblem,
} from "../src/domain/transcription";
import { processingMessages } from "../src/domain/processing-partner";

describe("Transcribing voice memos", () => {
  it("converts any recording to the 16 kHz mono WAV whisper.cpp reads", () => {
    expect(ffmpegArgs("/tmp/a/memo.m4a", "/tmp/a/memo.wav")).toEqual([
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", "/tmp/a/memo.m4a", "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "/tmp/a/memo.wav",
    ]);
  });

  it("asks whisper.cpp for the text alone, in the chosen language", () => {
    expect(whisperArgs("/models/ggml.bin", "/tmp/a/memo.wav", "DE")).toEqual(["-m", "/models/ggml.bin", "-f", "/tmp/a/memo.wav", "-l", "de", "-nt"]);
    expect(whisperArgs("/models/ggml.bin", "/tmp/a/memo.wav", "German")).toContain("auto");
  });

  it("joins the segments and leaves out markers for silence and sounds", () => {
    expect(cleanTranscript("\n [BLANK_AUDIO]\n Call Anna about the offer.\n (music)\n  And book the train.  \n")).toBe("Call Anna about the offer. And book the train.");
    expect(cleanTranscript("[BLANK_AUDIO]\n")).toBe("");
  });

  it("says in words when the model file isn't one", () => {
    expect(whisperProblem("whisper_model_load: invalid model data (bad magic)\nerror: failed to initialize whisper context"))
      .toContain("isn't a whisper.cpp model");
    expect(whisperProblem("something else")).toBeNull();
  });

  it("tells a model file from a web page, a pointer or another format", () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(modelFileProblem(1_624_555_275, bytes("lmgg\u0000\u0001"))).toBeNull();
    expect(modelFileProblem(30_000, bytes("<!DOCTYPE html><html>"))).toContain("(29 KB) is a web page");
    expect(modelFileProblem(134, bytes("version https://git-lfs.github.com/spec/v1"))).toContain("Git LFS pointer");
    expect(modelFileProblem(900 * 1024 * 1024, bytes("GGUF\u0003"))).toContain("(900 MB) is a GGUF model");
    expect(modelFileProblem(5, bytes("PK\u0003\u0004"))).toContain("doesn't start like one");
  });

  it("knows recordings by their extension", () => {
    expect(isAudioExtension("M4A")).toBe(true);
    expect(isAudioExtension("md")).toBe(false);
  });

  it("reads saved settings, with a language code or auto", () => {
    expect(parseTranscriptionSettings(undefined)).toEqual({ modelPath: "", language: "auto", whisperPath: "", ffmpegPath: "" });
    expect(parseTranscriptionSettings({ modelPath: " ~/m.bin ", language: "En", whisperPath: 3 }))
      .toEqual({ modelPath: "~/m.bin", language: "en", whisperPath: "", ffmpegPath: "" });
    expect(languageCode("")).toBe("auto");
  });

  it("gives the processing partner a memo's transcript as its text", () => {
    const request = {
      item: { title: "Memo 12.m4a", body: "Call Anna about the offer.", kind: "audio" as const },
      form: { project: "", projectIsNew: false, vision: "", action: "", status: "next", context: "" },
      projects: [],
      contexts: [],
    };
    expect(processingMessages(request)[1]!.content).toContain("Inbox item (a voice memo; its transcript follows): Memo 12.m4a\n\nCall Anna about the offer.");
    expect(processingMessages({ ...request, item: { ...request.item, body: "" } })[1]!.content).toContain("(a voice memo, not transcribed)");
  });
});
