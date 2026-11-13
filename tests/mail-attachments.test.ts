import { describe, expect, it } from "vitest";
import type { BodyPart } from "../src/domain/imap-protocol";
import {
  attachmentCallout,
  attachmentFileName,
  attachmentParts,
  EMBEDDED_IMAGE_MIN_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  planAttachments,
} from "../src/domain/mail-attachments";
import { decodeBase64, mimeParameter } from "../src/domain/mime";

const part = (changes: Partial<BodyPart> & { name?: string } = {}): BodyPart => {
  const { name, ...rest } = changes;
  return {
    path: "2",
    type: "application",
    subtype: "pdf",
    charset: "",
    encoding: "base64",
    size: 4_000,
    disposition: "attachment",
    parameters: new Map(name === undefined ? [] : [["filename", name]]),
    contentId: "",
    ...rest,
  };
};

describe("Which parts are attachments", () => {
  const text = part({ path: "1.1", type: "text", subtype: "plain", disposition: "" });
  const html = part({ path: "1.2", type: "text", subtype: "html", disposition: "" });

  it("leaves out the message's own text in either version", () => {
    expect(attachmentParts([text, html], text)).toEqual([]);
  });

  it("counts a file, including a text file, sent as an attachment", () => {
    const csv = part({ path: "3", type: "text", subtype: "csv", name: "numbers.csv" });
    const pdf = part({ name: "quote.pdf" });
    expect(attachmentParts([text, html, pdf, csv], text)).toEqual([pdf, csv]);
  });

  it("takes a small image embedded in the HTML for decoration, a large one for content", () => {
    const logo = part({ type: "image", subtype: "png", disposition: "inline", contentId: "<logo>", size: 3_000 });
    const screenshot = part({ type: "image", subtype: "png", disposition: "inline", contentId: "<shot>", size: EMBEDDED_IMAGE_MIN_BYTES });
    expect(attachmentParts([text, logo, screenshot], text)).toEqual([screenshot]);
  });

  it("counts an embedded image the sender also marked as an attachment", () => {
    const attached = part({ type: "image", subtype: "png", contentId: "<x>", size: 3_000 });
    expect(attachmentParts([text, attached], text)).toEqual([attached]);
  });
});

describe("What is saved", () => {
  const plan = (parts: BodyPart[], limitMb = 10) => planAttachments(parts, { enabled: true, limitMb }).map((entry) => entry.skip ?? "save");

  it("saves documents, images and recordings", () => {
    expect(plan(["quote.pdf", "scan.JPG", "memo.m4a", "sheet.xlsx", "invite.ics"].map((name) => part({ name }))))
      .toEqual(["save", "save", "save", "save", "save"]);
  });

  it("never saves what Obsidian or the Mac would run or read as a note", () => {
    const names = ["setup.exe", "notes.md", "board.canvas", "page.html", "logo.svg", "run.sh", "files.zip", "macro.docm", "old.xls",
      "invoice.pdf.exe", "app.command", "data.json"];
    expect(plan(names.map((name) => part({ name })))).toEqual(names.map(() => "kind"));
  });

  it("goes by the extension the file is saved with, not the type the sender declared", () => {
    expect(plan([part({ name: "photo.exe", type: "image", subtype: "jpeg" })])).toEqual(["kind"]);
    expect(plan([part({ type: "application", subtype: "pdf" })])).toEqual(["save"]);
    expect(plan([part({ type: "application", subtype: "octet-stream" })])).toEqual(["kind"]);
  });

  it("leaves a file larger than the limit in the message, judged by its decoded size", () => {
    // 13.4 MB of base64 is 10 MB of file.
    expect(plan([part({ name: "a.pdf", size: 13_300_000 }), part({ name: "b.pdf", size: 13_400_000 })])).toEqual(["save", "size"]);
    expect(plan([part({ name: "a.pdf", size: 1_200_000, encoding: "7bit" })], 1)).toEqual(["size"]);
  });

  it(`saves at most ${MAX_ATTACHMENTS_PER_MESSAGE} per message`, () => {
    const parts = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 2 }, (_, index) => part({ name: `${index}.pdf` }));
    expect(plan(parts).filter((skip) => skip === "count")).toHaveLength(2);
  });

  it("saves nothing when it is turned off", () => {
    expect(planAttachments([part({ name: "a.pdf" })], { enabled: false, limitMb: 10 })[0]?.skip).toBe("off");
  });
});

describe("Naming a saved attachment", () => {
  it("keeps an ordinary name and lowercases the extension", () => {
    expect(attachmentFileName(part({ name: "Angebot 2026.PDF" }))).toBe("Angebot 2026.pdf");
  });

  it("drops folders, leading dots and characters links can't hold", () => {
    expect(attachmentFileName(part({ name: "../../.obsidian/plugins/x.pdf" }))).toBe("x.pdf");
    expect(attachmentFileName(part({ name: "..hidden.pdf" }))).toBe("hidden.pdf");
    expect(attachmentFileName(part({ name: "a[[b]]|c#d^e.pdf" }))).toBe("a--b---c-d-e.pdf");
  });

  it("removes characters that disguise the real extension", () => {
    // Right-to-left override: shown as "invoiceexe.pdf", really an .exe.
    expect(attachmentFileName(part({ name: "invoice‮fdp.exe" }))).toBe("invoicefdp.exe");
  });

  it("names a part without a name after its type", () => {
    expect(attachmentFileName(part({ type: "image", subtype: "jpeg" }))).toBe("Attachment.jpg");
    expect(attachmentFileName(part({ type: "application", subtype: "x-unknown" }))).toBe("Attachment");
  });

  it("reads names in the encodings mail uses for them", () => {
    expect(mimeParameter(new Map([["filename*", "utf-8''%C3%9Cbersicht.pdf"]]), "filename")).toBe("Übersicht.pdf");
    expect(mimeParameter(new Map([["filename*0*", "utf-8''%C3%9Cber"], ["filename*1", "sicht.pdf"]]), "filename")).toBe("Übersicht.pdf");
    expect(mimeParameter(new Map([["name", "=?UTF-8?B?w5xiZXJzaWNodC5wZGY=?="]]), "name")).toBe("Übersicht.pdf");
    expect(mimeParameter(new Map(), "filename")).toBe("");
  });
});

describe("The note's attachment callout", () => {
  it("is empty for a message without attachments", () => {
    expect(attachmentCallout([], 10)).toBe("");
  });

  it("links what was saved and says why the rest stayed in the message", () => {
    expect(attachmentCallout([
      { fileName: "quote.pdf", bytes: 240_000, path: "GTD/Inbox/quote.pdf" },
      { fileName: "film.mov", bytes: 80_000_000, skip: "size" },
      { fileName: "tool.exe", bytes: 1_200, skip: "kind" },
      { fileName: "scan.pdf", bytes: 0, skip: "failed" },
    ], 10)).toBe([
      "> [!dg-attachments] 4 attachments, 1 saved as an Inbox Item",
      "> - [[GTD/Inbox/quote.pdf|quote.pdf]] · 240 KB",
      "> - film.mov · 80 MB · not imported: larger than 10 MB",
      "> - tool.exe · 1 KB · not imported: Dragonglass doesn't save this kind of file",
      "> - scan.pdf · not imported: it couldn't be downloaded",
    ].join("\n"));
  });

  it("says so in its title when every one was saved", () => {
    expect(attachmentCallout([{ fileName: "a.pdf", bytes: 10, path: "GTD/Inbox/a.pdf" }], 10).split("\n")[0])
      .toBe("> [!dg-attachments] 1 attachment, an Inbox Item of its own");
  });
});

describe("Decoding an attachment", () => {
  it("decodes base64 across line breaks into the exact bytes", () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 7) % 256);
    const encoded = btoa(String.fromCharCode(...bytes)).replace(/(.{76})/g, "$1\r\n");
    expect(decodeBase64(encoded)).toEqual(bytes);
  });
});
