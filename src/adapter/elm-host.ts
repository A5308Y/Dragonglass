import { Notice } from "obsidian";
import type { ElmCommandEnvelope, ElmCommandResultEvent } from "./protocol";
import { logTiming, timingLog } from "../utils/timing";

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
  /** The view's name in the timing log. */
  surface: string;
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
  const start = timingLog() ? performance.now() : 0;
  const type = (envelope.command as { type?: unknown }).type;
  try {
    const result = await options.execute(envelope.command);
    if (start) logTiming(`${options.surface}: ${String(type)}`, performance.now() - start);
    options.reply({
      type: "command-result",
      requestId: envelope.requestId,
      ok: true,
      ...(result === undefined ? {} : { value: result }),
    });
  } catch (error) {
    if (start) logTiming(`${options.surface}: ${String(type)} failed`, performance.now() - start);
    const message = error instanceof Error ? error.message : options.failureMessage;
    options.reply({ type: "command-result", requestId: envelope.requestId, ok: false, error: message });
    if (options.notifyErrors !== false) new Notice(message);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled Elm command: ${JSON.stringify(value)}`);
}
