#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("1.2.3-test");
  process.exit(0);
}

const required = ["--print", "--verbose", "--replay-user-messages"];
const missing = required.filter((arg) => !args.includes(arg));
if (missing.length > 0 || valueAfter("--input-format") !== "stream-json" || valueAfter("--output-format") !== "stream-json") {
  console.error(`missing structured flags: ${missing.join(",")}`);
  process.exit(64);
}

const recordPath = process.env.FAKE_CLAUDE_RECORD_PATH;
if (recordPath) {
  fs.appendFileSync(recordPath, JSON.stringify({ argv: args, pid: process.pid }) + "\n", "utf8");
}

if (process.env.FAKE_CLAUDE_MODE === "idle") {
  setInterval(() => {}, 1000);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  input += chunk;
  let index;
  while ((index = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (!line.trim()) continue;
    if (recordPath) fs.appendFileSync(recordPath, line + "\n", "utf8");
    if (process.env.FAKE_CLAUDE_MODE === "crash-after-stdin") {
      console.error("synthetic Claude Code child crash after pending prompt");
      setTimeout(() => process.exit(17), 10);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const promptText = extractText(parsed.message?.content) || "Hello";
    const priorResume = valueAfter("--resume");
    const sessionId = priorResume || "fake-claude-session";
    await emit({ type: "system", subtype: "init", session_id: sessionId, model: "sonnet" });
    await emit({ type: "user", message: { role: "user", content: [{ type: "text", text: promptText }] } });
    await emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hi " }] } });
    await emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "there 🚀" }] } });
    const result = { type: "result", subtype: "success", session_id: sessionId, result: "Hi there 🚀", is_error: false, usage: { input_tokens: 4, output_tokens: 3 } };
    await emit(result, process.env.FAKE_CLAUDE_FINAL_NO_NEWLINE === "1");
    if (process.env.FAKE_CLAUDE_MODE === "exit-after-result") process.exit(0);
  }
});

process.on("SIGTERM", () => {
  if (recordPath) fs.appendFileSync(recordPath, JSON.stringify({ signal: "SIGTERM" }) + "\n", "utf8");
  process.exit(143);
});

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text || "").join("");
}

async function emit(event, omitNewline = false) {
  const line = JSON.stringify(event) + (omitNewline ? "" : "\n");
  if (process.env.FAKE_CLAUDE_SPLIT === "1") {
    const buf = Buffer.from(line, "utf8");
    for (let i = 0; i < buf.length; i += 3) {
      process.stdout.write(buf.subarray(i, Math.min(i + 3, buf.length)));
      await delay(1);
    }
    return;
  }
  process.stdout.write(line);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
