// A minimal MCP server (stdio, newline-delimited JSON-RPC) with one tool, ask_human, so Codex
// can ask the person questions through the same files as every other runner:
// exchange/questions/<id>.json, answered by exchange/answers/<id>.json.
// No dependencies: the protocol needs only initialize, tools/list and tools/call.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const EXCHANGE = path.join(process.env.AGENT_WORKSPACE || "/workspace", "exchange");
const QUESTIONS = path.join(EXCHANGE, "questions");
const ANSWERS = path.join(EXCHANGE, "answers");
const ANSWER_TIMEOUT_MS = Number(process.env.AGENT_ANSWER_TIMEOUT_MINUTES || 240) * 60_000;

const TOOL = {
  name: "ask_human",
  description: "Ask the person who delegated this work a question and wait for the answer. Use it when a decision is theirs, "
    + "or information you need is missing and you can't find it. One clear, self-contained question. Answers can take hours.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string", description: "The question, with the options you see if there are any." } },
    required: ["question"],
  },
};

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function askHuman(question) {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  await fs.mkdir(QUESTIONS, { recursive: true });
  await fs.writeFile(path.join(QUESTIONS, `${id}.json`), `${JSON.stringify({ id, question, askedAt: new Date().toISOString() }, null, 2)}\n`);
  const deadline = Date.now() + ANSWER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { answer } = JSON.parse(await fs.readFile(path.join(ANSWERS, `${id}.json`), "utf8"));
      if (typeof answer === "string") return answer;
    } catch {
      // Not there yet, or still being written.
    }
    await sleep(2_000);
  }
  return "No answer arrived in time. Continue with your best judgement, and list the question as open in REPORT.md.";
}

async function handle(request) {
  const { id, method, params } = request;
  // Notifications carry no id and get no answer.
  if (id === undefined) return;
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "dragonglass", version: "0.1.0" },
        },
      });
    case "ping":
      return send({ id, result: {} });
    case "tools/list":
      return send({ id, result: { tools: [TOOL] } });
    case "tools/call": {
      if (params?.name !== TOOL.name) return send({ id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
      const question = String(params?.arguments?.question ?? "").trim();
      if (!question) return send({ id, result: { content: [{ type: "text", text: "Ask a question." }], isError: true } });
      const answer = await askHuman(question);
      return send({ id, result: { content: [{ type: "text", text: answer }] } });
    }
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  void handle(request);
});
