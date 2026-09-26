// The agent's only way out of its sandbox network, and the only place the API key lives.
//
// Two jobs on one port:
//   - Claude API: the agent's ANTHROPIC_BASE_URL points here. Requests to /v1/... go to
//     api.anthropic.com with the real key added; the agent only ever holds a placeholder.
//   - Everything else: the agent's HTTP(S)_PROXY points here too. HTTPS arrives as
//     CONNECT host:port, which is tunnelled without being decrypted; plain HTTP is
//     forwarded. Destinations on your Mac or your local network are refused, and so
//     are ports other than ALLOWED_PORTS.
//
// Every request is appended to PROXY_LOG as one JSON line. For HTTPS only the host is
// visible, never the path or the content.

import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const PORT = Number(process.env.PROXY_PORT || 8080);
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const LOG = process.env.PROXY_LOG || "/logs/requests.jsonl";
const ALLOWED_PORTS = new Set((process.env.ALLOWED_PORTS || "80,443").split(",").map(Number));

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set for the proxy.");
  process.exit(1);
}

function log(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.appendFile(LOG, `${line}\n`, () => {});
  console.log(line);
}

// Loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges:
// your Mac (host.docker.internal), your router, other devices, cloud metadata.
function isPrivate(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivate(lower.slice(7));
  return lower === "::" || lower === "::1"
    || lower.startsWith("fc") || lower.startsWith("fd")
    || /^fe[89ab]/.test(lower)
    || lower.startsWith("ff");
}

/**
 * The address to connect to, or a reason to refuse. Every resolved address must be
 * public, and the connection goes to one of those, so a name cannot be re-resolved
 * to a private address between the check and the connection.
 */
async function resolvePublic(host, port) {
  if (!ALLOWED_PORTS.has(port)) return { refused: `port ${port} is not allowed` };
  const bare = host.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = net.isIP(bare) ? [{ address: bare }] : await dns.lookup(bare, { all: true });
  } catch (error) {
    return { refused: `cannot resolve: ${error.code || error.message}` };
  }
  if (!addresses.length) return { refused: "no address" };
  if (addresses.some(({ address }) => isPrivate(address))) return { refused: "private or local address" };
  return { address: addresses[0].address };
}

function withoutHopHeaders(headers) {
  const copy = { ...headers };
  for (const name of ["proxy-connection", "proxy-authorization", "connection", "keep-alive", "transfer-encoding", "upgrade"]) {
    delete copy[name];
  }
  return copy;
}

function forwardToClaude(req, res) {
  if (!req.url.startsWith("/v1/")) {
    res.writeHead(404).end();
    log({ kind: "api", method: req.method, path: req.url, refused: "not a /v1 path" });
    return;
  }
  const headers = withoutHopHeaders(req.headers);
  delete headers.authorization;
  headers["x-api-key"] = API_KEY;
  headers.host = "api.anthropic.com";
  const started = Date.now();
  const upstream = https.request(
    { host: "api.anthropic.com", port: 443, method: req.method, path: req.url, headers },
    (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
      response.on("end", () => log({ kind: "api", method: req.method, path: req.url, status: response.statusCode, ms: Date.now() - started }));
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
    log({ kind: "api", method: req.method, path: req.url, error: error.message });
  });
  req.pipe(upstream);
}

async function forwardHttp(req, res) {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const port = Number(target.port || 80);
  const { address, refused } = await resolvePublic(target.hostname, port);
  if (refused) {
    res.writeHead(403).end(`Refused by the Dragonglass proxy: ${refused}\n`);
    log({ kind: "http", method: req.method, url: req.url, refused });
    return;
  }
  const headers = withoutHopHeaders(req.headers);
  const upstream = http.request(
    { host: address, port, method: req.method, path: `${target.pathname}${target.search}`, headers: { ...headers, host: target.host } },
    (response) => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
      log({ kind: "http", method: req.method, url: req.url, status: response.statusCode });
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
    log({ kind: "http", method: req.method, url: req.url, error: error.message });
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/")) forwardToClaude(req, res);
  else void forwardHttp(req, res);
});

server.on("connect", async (req, client, head) => {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url || "");
  if (!match) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const host = match[1];
  const port = Number(match[2]);
  const { address, refused } = await resolvePublic(host, port);
  if (refused) {
    // The reason goes in the status line and the body, so the agent can tell a policy
    // refusal from a service that is down.
    const reason = `Refused by the Dragonglass proxy: ${refused}`;
    client.end(`HTTP/1.1 403 ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason) + 1}\r\n\r\n${reason}\n`);
    log({ kind: "connect", host, port, refused });
    return;
  }
  const upstream = net.connect(port, address, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    log({ kind: "connect", host, port, address });
  });
  const close = () => {
    upstream.destroy();
    client.destroy();
  };
  upstream.on("error", (error) => {
    log({ kind: "connect", host, port, error: error.message });
    close();
  });
  client.on("error", close);
});

server.listen(PORT, () => console.log(`Dragonglass agent proxy listening on ${PORT}, logging to ${LOG}`));
