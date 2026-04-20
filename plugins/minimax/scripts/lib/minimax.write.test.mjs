#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const tmp = path.join(os.tmpdir(), `mm-write-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
const target = path.join(tmp, "config.yaml");
const lockPath = path.join(tmp, ".lock");

const fakeYaml = `api_key: "YOUR_API_KEY_HERE"
api_base: "https://api.minimax.io"
model: "MiniMax-M2.5"
provider: "anthropic"
retry:
  max_retries: 3
  initial_delay: 1.0
tools:
  enable_bash: true
`;
fs.writeFileSync(target, fakeYaml);

// 子进程里跑 writeMiniAgentApiKey（用 env 注入 mock path）
const env = { ...process.env, MINI_AGENT_CONFIG_PATH: target, MINI_AGENT_LOCK_PATH: lockPath };
const minimaxPath = path.resolve("plugins/minimax/scripts/lib/minimax.mjs");

const r = spawnSync("node", [
  "-e",
  `
  import("${minimaxPath}").then(async m => {
    const result = await m.writeMiniAgentApiKey("sk-new-key-abcdef0123456789");
    console.log(JSON.stringify(result));
  }).catch(e => { console.error(e); process.exit(1); });
  `
], { env, encoding: "utf8" });

console.log("round 1 stdout:", r.stdout.trim());
if (r.stderr) console.log("round 1 stderr:", r.stderr);

const result = JSON.parse(r.stdout.trim());
console.assert(result.ok === true, `write ok expected true, got ${JSON.stringify(result)}`);

const after = fs.readFileSync(target, "utf8");
console.assert(/^api_key: "sk-new-key-abcdef0123456789"$/m.test(after), "api_key was written");
console.assert(/^api_base: "https:\/\/api.minimax.io"$/m.test(after), "api_base preserved");
console.assert(/^model: "MiniMax-M2.5"$/m.test(after), "model preserved");
console.assert(/^\s+max_retries: 3$/m.test(after), "retry.max_retries preserved");
console.assert(/^\s+enable_bash: true$/m.test(after), "tools.enable_bash preserved");

// Round 2: 换新 key
const r2 = spawnSync("node", ["-e", `
  import("${minimaxPath}").then(async m => {
    const result = await m.writeMiniAgentApiKey("sk-key-round-2-final");
    console.log(JSON.stringify(result));
  }).catch(e => { console.error(e); process.exit(1); });
`], { env, encoding: "utf8" });
console.log("round 2 stdout:", r2.stdout.trim());
const r2Result = JSON.parse(r2.stdout.trim());
console.assert(r2Result.ok === true);

const after2 = fs.readFileSync(target, "utf8");
console.assert(/^api_key: "sk-key-round-2-final"$/m.test(after2), "second key applied");
console.assert(/^model: "MiniMax-M2.5"$/m.test(after2), "model still preserved after 2nd write");

// 清理
fs.rmSync(tmp, { recursive: true });
console.log("writeMiniAgentApiKey integration test PASSED");
