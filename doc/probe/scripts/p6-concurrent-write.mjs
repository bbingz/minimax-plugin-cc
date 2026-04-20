#!/usr/bin/env node
// 模拟 20 并发无锁写 YAML，**只碰 mock path**
import fs from "node:fs";

const YAML = process.env.MINI_AGENT_CONFIG_PATH || "/tmp/mm-p6-mock.yaml";

function readApiKey(text) {
  const m = text.match(/^api_key:\s*"?([^"#\n]*)"?\s*(?:#.*)?$/m);
  return m ? m[1].trim() : null;
}

async function naiveWrite(newKey, tag) {
  const text = fs.readFileSync(YAML, "utf8");
  const next = text.replace(/^api_key:\s*.*$/m, `api_key: "${newKey}"`);
  await new Promise(r => setTimeout(r, Math.random() * 50));
  fs.writeFileSync(YAML, next);
}

const runs = 20;
const keys = Array.from({ length: runs }, (_, i) => `sk-probe-${i}-${Date.now()}`);
await Promise.all(keys.map((k, i) => naiveWrite(k, i)));
const finalKey = readApiKey(fs.readFileSync(YAML, "utf8"));
console.log(`final api_key = ${finalKey}`);
console.log(`final key is one of the writes? ${keys.includes(finalKey)}`);
console.log(`file size = ${fs.statSync(YAML).size}`);
// 检查其他字段是否保留
const raw = fs.readFileSync(YAML, "utf8");
console.log("model line preserved:", /^model:/m.test(raw));
console.log("api_base line preserved:", /^api_base:/m.test(raw));
console.log("retry block preserved:", /^retry:/m.test(raw));
