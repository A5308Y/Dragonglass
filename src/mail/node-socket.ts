/**
 * The real transport, and the only place Dragonglass touches Node.
 *
 * IMAP is a TLS socket, and Obsidian's own API offers no way to open one —
 * `requestUrl` speaks HTTP and nothing else. So this reaches for Node's `tls`, which
 * exists in the desktop app and does not exist on mobile at all.
 *
 * The require is deliberately indirect and lazy: a static import would be resolved
 * at build time and would throw on mobile as the plugin loaded, taking every other
 * surface down with it. Asked for here instead, mobile gets a sentence explaining
 * itself and the rest of the plugin carries on.
 */

import type { ImapSocket } from "./imap-client";

/** How long the TLS handshake is given before the attempt is abandoned. */
const CONNECT_TIMEOUT_MS = 20_000;

interface NodeSocket {
  setEncoding(encoding: string): void;
  setTimeout(timeout: number): void;
  on(event: string, listener: (...args: never[]) => void): void;
  write(data: string): void;
  end(): void;
  destroy(): void;
}

interface NodeTls {
  connect(options: Record<string, unknown>, listener: () => void): NodeSocket;
}

function nodeRequire(): ((id: string) => unknown) | null {
  const candidate = (globalThis as Record<string, unknown>).require;
  return typeof candidate === "function" ? (candidate as (id: string) => unknown) : null;
}

/** Whether this platform can open an IMAP connection at all. */
export function mailTransportAvailable(): boolean {
  return nodeRequire() !== null;
}

export const MOBILE_EXPLANATION =
  "Importing mail needs the desktop app: Obsidian on mobile cannot open an IMAP connection. "
  + "Imported messages are ordinary Inbox Items, so they reach this device through vault sync.";

/**
 * Opens an implicit-TLS connection.
 *
 * Certificate validation is left on, always. A mail password crosses this socket,
 * and an option to skip verification is an option to hand it to whoever is in the
 * middle — so there is no setting for it.
 */
export async function openTlsSocket(target: { host: string; port: number }): Promise<ImapSocket> {
  const required = nodeRequire();
  if (!required) throw new Error(MOBILE_EXPLANATION);
  const tls = required("tls") as NodeTls;

  return new Promise<ImapSocket>((resolve, reject) => {
    let settled = false;
    const listeners: {
      data: Array<(chunk: string) => void>;
      error: Array<(error: Error) => void>;
      close: Array<() => void>;
    } = { data: [], error: [], close: [] };

    const socket = tls.connect(
      {
        host: target.host,
        port: target.port,
        // Named so the server can pick the right certificate, and so validation checks it.
        servername: target.host,
        rejectUnauthorized: true,
      },
      () => {
        if (settled) return;
        settled = true;
        socket.setTimeout(0);
        resolve({
          write: (data) => socket.write(data),
          onData: (listener) => listeners.data.push(listener),
          onError: (listener) => listeners.error.push(listener),
          onClose: (listener) => listeners.close.push(listener),
          close: () => {
            try {
              socket.end();
            } finally {
              socket.destroy();
            }
          },
        });
      },
    );

    // One byte per character, which is what makes a literal's byte count usable as an index.
    socket.setEncoding("latin1");
    socket.setTimeout(CONNECT_TIMEOUT_MS);

    socket.on("timeout", () => {
      const failure = new Error(`${target.host} did not answer in time.`);
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(failure);
      } else for (const listener of listeners.error) listener(failure);
    });

    socket.on("data", ((chunk: string) => {
      for (const listener of listeners.data) listener(chunk);
    }) as (...args: never[]) => void);

    socket.on("error", ((error: Error) => {
      if (!settled) {
        settled = true;
        reject(new Error(`${target.host} could not be reached: ${error.message}`));
      } else for (const listener of listeners.error) listener(error);
    }) as (...args: never[]) => void);

    socket.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error(`${target.host} closed the connection before it was ready.`));
      } else for (const listener of listeners.close) listener();
    });
  });
}
