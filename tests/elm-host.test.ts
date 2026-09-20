import { describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => [] as string[]);

vi.mock("obsidian", () => ({
  Notice: class {
    constructor(message: string) {
      notices.push(message);
    }
  },
}));

import { subscribeElmCommands, type ElmOutgoingPort } from "../src/adapter/elm-host";
import type { ElmCommandEnvelope, ElmCommandResultEvent } from "../src/adapter/protocol";

interface TestCommand {
  type: "run";
  value: string;
}

function parser(value: unknown): ElmCommandEnvelope<TestCommand> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ElmCommandEnvelope<TestCommand>>;
  return candidate.requestId && candidate.command?.type === "run"
    ? candidate as ElmCommandEnvelope<TestCommand>
    : null;
}

function fakePort(): { port: ElmOutgoingPort; emit(value: unknown): void; subscribed(): boolean } {
  let listener: ((value: unknown) => void) | null = null;
  return {
    port: {
      subscribe(next) {
        listener = next;
      },
      unsubscribe(current) {
        if (listener === current) listener = null;
      },
    },
    emit(value) {
      listener?.(value);
    },
    subscribed() {
      return listener !== null;
    },
  };
}

describe("Elm command host", () => {
  it("owns subscription, execution, reply, and teardown", async () => {
    const outgoing = fakePort();
    const replies: ElmCommandResultEvent[] = [];
    const execute = vi.fn(async (command: TestCommand) => command.value.toUpperCase());
    const unsubscribe = subscribeElmCommands({
      port: outgoing.port,
      parse: parser,
      execute,
      reply: (event) => replies.push(event),
      failureMessage: "Failed.",
    });

    outgoing.emit({ requestId: "request-1", command: { type: "run", value: "done" } });
    await vi.waitFor(() => expect(replies).toEqual([
      { type: "command-result", requestId: "request-1", ok: true, value: "DONE" },
    ]));
    expect(execute).toHaveBeenCalledWith({ type: "run", value: "done" });

    unsubscribe();
    expect(outgoing.subscribed()).toBe(false);
  });

  it("reports failures and ignores invalid messages", async () => {
    notices.length = 0;
    const outgoing = fakePort();
    const replies: ElmCommandResultEvent[] = [];
    subscribeElmCommands<TestCommand>({
      port: outgoing.port,
      parse: parser,
      execute: async () => {
        throw new Error("Operation failed.");
      },
      reply: (event) => replies.push(event),
      failureMessage: "Failed.",
    });

    outgoing.emit({ requestId: "invalid" });
    outgoing.emit({ requestId: "request-2", command: { type: "run", value: "fail" } });

    await vi.waitFor(() => expect(replies).toEqual([
      { type: "command-result", requestId: "request-2", ok: false, error: "Operation failed." },
    ]));
    expect(notices).toEqual([
      "Dragonglass ignored an invalid Elm command.",
      "Operation failed.",
    ]);
  });
});
