#!/usr/bin/env node
// What delegating has cost, per sub-project, from every run's exchange/result.json.
//
//   node scripts/costs.mjs [runs dir]      defaults to ./runs
//
// Costs are the SDK's estimates from token counts and list prices. The Claude Console's
// usage page is the authoritative bill.

import fs from "node:fs";
import path from "node:path";

const runsDir = process.argv[2] || "runs";
if (!fs.existsSync(runsDir)) {
  console.error(`No runs folder at ${runsDir}.`);
  process.exit(1);
}

const byProject = new Map();
for (const name of fs.readdirSync(runsDir).sort()) {
  const runDir = path.join(runsDir, name);
  if (!fs.statSync(runDir).isDirectory()) continue;
  const resultFile = path.join(runDir, "exchange", "result.json");
  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  } catch {
    // Never finished, or started before results named their project.
    result = { project: `(unknown: run ${name})`, subtype: "no result", costUsd: null };
  }
  const project = result.project || `(unknown: run ${name})`;
  const entry = byProject.get(project) ?? { runs: [], total: 0, unknown: 0 };
  entry.runs.push({ name, ...result });
  if (typeof result.costUsd === "number") entry.total += result.costUsd;
  else entry.unknown += 1;
  byProject.set(project, entry);
}

if (!byProject.size) {
  console.log("No runs yet.");
  process.exit(0);
}

let grandTotal = 0;
for (const [project, { runs, total, unknown }] of [...byProject].sort((a, b) => b[1].total - a[1].total)) {
  grandTotal += total;
  console.log(`${project}\n  $${total.toFixed(2)} over ${runs.length} run${runs.length === 1 ? "" : "s"}`
    + (unknown ? `, ${unknown} without a known cost` : ""));
  for (const run of runs) {
    const cost = typeof run.costUsd === "number" ? `$${run.costUsd.toFixed(2)}` : "cost unknown";
    const detail = [run.model, run.subtype, run.startedAt?.slice(0, 16).replace("T", " ")].filter(Boolean).join(" · ");
    console.log(`    ${run.name}: ${cost}  (${detail})${run.costWarning ? `  ⚠️ ${run.costWarning}` : ""}`);
  }
}
console.log(`\nTotal: $${grandTotal.toFixed(2)} (estimated; the Claude Console has the actual bill)`);
