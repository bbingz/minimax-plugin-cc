#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_DIR = path.join(os.homedir(), ".mini-agent", "log");
function listLogs() {
  return fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".log"));
}

async function runOne(tag) {
  const before = new Set(listLogs());
  const proc = spawn("mini-agent", ["-t", `tag=${tag} say OK`, "-w", "/tmp"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  proc.stdout.on("data", c => { stdout += c.toString("utf8"); });
  await new Promise(res => proc.once("close", res));
  const after = new Set(listLogs());
  const diff = [...after].filter(f => !before.has(f));
  // 从 stdout 里抓 log path，strip ANSI
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const m = clean.match(/Log file:\s+(\S+\.log)/);
  const stdoutLog = m ? path.basename(m[1]) : null;
  return { tag, diffLogs: diff, stdoutLog };
}

async function runRound(round) {
  console.log(`\n=== Round ${round} ===`);
  const results = await Promise.all([1, 2, 3].map(i => runOne(`R${round}T${i}`)));
  console.log(JSON.stringify(results, null, 2));
  results.forEach(r => {
    const match = r.stdoutLog && r.diffLogs.includes(r.stdoutLog);
    console.log(`${r.tag}: diff_count=${r.diffLogs.length} stdout_in_diff=${match} stdoutLog=${r.stdoutLog}`);
  });
  return results;
}

const allRounds = [];
for (let r = 1; r <= 3; r++) {
  allRounds.push(await runRound(r));
}

// 汇总
console.log("\n=== Summary ===");
let total = 0, attribSuccess = 0;
for (const round of allRounds) {
  for (const r of round) {
    total++;
    if (r.stdoutLog && r.diffLogs.includes(r.stdoutLog)) attribSuccess++;
  }
}
console.log(`Total spawns: ${total}, successful attribution: ${attribSuccess}`);
console.log(`Attribution success rate: ${(attribSuccess/total*100).toFixed(1)}%`);
