#!/usr/bin/env node
// Answers the agent's questions until Dragonglass can.
//
//   node scripts/answer.mjs <run dir>                  lists the open questions
//   node scripts/answer.mjs <run dir> <id> "answer"    answers one

import fs from "node:fs";
import path from "node:path";

const [runDir, id, ...words] = process.argv.slice(2);
if (!runDir) {
  console.error('Usage: node scripts/answer.mjs <run dir> [<question id> "answer"]');
  process.exit(2);
}
const questions = path.join(runDir, "exchange", "questions");
const answers = path.join(runDir, "exchange", "answers");

if (!id) {
  const open = fs.existsSync(questions)
    ? fs.readdirSync(questions).filter((file) => file.endsWith(".json") && !fs.existsSync(path.join(answers, file)))
    : [];
  if (!open.length) console.log("No open questions.");
  for (const file of open.sort()) {
    const { id: questionId, question, askedAt } = JSON.parse(fs.readFileSync(path.join(questions, file), "utf8"));
    console.log(`${questionId}  (asked ${askedAt})\n${question}\n`);
  }
  process.exit(0);
}

const answer = words.join(" ").trim();
if (!answer) {
  console.error("Give the answer after the question id.");
  process.exit(2);
}
if (!fs.existsSync(path.join(questions, `${id}.json`))) {
  console.error(`No question ${id} in ${questions}.`);
  process.exit(1);
}
fs.mkdirSync(answers, { recursive: true });
// Written aside and renamed, so the agent never reads half an answer.
const target = path.join(answers, `${id}.json`);
fs.writeFileSync(`${target}.tmp`, `${JSON.stringify({ id, answer, answeredAt: new Date().toISOString() }, null, 2)}\n`);
fs.renameSync(`${target}.tmp`, target);
console.log(`Answered ${id}.`);
