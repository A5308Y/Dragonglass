import { Notice } from "obsidian";
import type { ElmCommandEnvelope, ElmCommandResultEvent } from "./protocol";

export interface ElmOutgoingPort {
  subscribe(listener: (value: unknown) => void): void;
  unsubscribe(listener: (value: unknown) => void): void;
}

interface CommandBridgeOptions<C> {
  port: ElmOutgoingPort;
  parse(value: unknown): ElmCommandEnvelope<C> | null;
  execute(command: C): Promise<unknown>;
  reply(event: ElmCommandResultEvent): void;
  failureMessage: string;
  notifyErrors?: boolean;
}

/**
 * Owns the identical request/reply lifecycle shared by every Elm surface.
 * Returns the exact unsubscriber adapters should call when their surface closes.
 */
export function subscribeElmCommands<C>(options: CommandBridgeOptions<C>): () => void {
  const listener = (value: unknown): void => {
    void receiveElmCommand(value, options);
  };
  options.port.subscribe(listener);
  return () => options.port.unsubscribe(listener);
}

async function receiveElmCommand<C>(value: unknown, options: CommandBridgeOptions<C>): Promise<void> {
  const envelope = options.parse(value);
  if (!envelope) {
    new Notice("Dragonglass ignored an invalid Elm command.");
    return;
  }
  try {
    const result = await options.execute(envelope.command);
    options.reply({
      type: "command-result",
      requestId: envelope.requestId,
      ok: true,
      ...(result === undefined ? {} : { value: result }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : options.failureMessage;
    options.reply({ type: "command-result", requestId: envelope.requestId, ok: false, error: message });
    if (options.notifyErrors !== false) new Notice(message);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled Elm command: ${JSON.stringify(value)}`);
}
