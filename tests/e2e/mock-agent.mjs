#!/usr/bin/env node
/**
 * Mock pi-coding-agent for E2E tests — child-process mode.
 * Wraps MockAgentCore with stdin/stdout JSONL protocol.
 *
 * In-process mode lives in in-process-mock-bridge.mjs (used by both
 * harnesses to skip the Node subprocess entirely).
 *
 * Usage: node mock-agent.mjs --mode rpc [--cwd ...] [--tools ...]
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MockAgentCore, mockModelFromString } from "./mock-agent-core.mjs";

const argv = process.argv;
const cwd = argv.includes("--cwd") ? argv[argv.indexOf("--cwd") + 1] : process.cwd();

function lastModelArg(args) {
	let model;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--model" && i + 1 < args.length) {
			model = args[++i];
		} else if (typeof arg === "string" && arg.startsWith("--model=")) {
			model = arg.slice("--model=".length);
		}
	}
	return mockModelFromString(model) ? model : undefined;
}

const agent = new MockAgentCore({ cwd, env: process.env, initialModel: lastModelArg(argv) });

/** Send a JSONL message to stdout */
function send(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

agent.setEventEmitter((event) => send(event));

const rl = createInterface({ input: process.stdin });

// Serialize handlePrompt calls so concurrent prompts don't interleave
// (matches the real agent's sequential stream behaviour).
let promptChain = Promise.resolve();

rl.on("line", async (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;

	let msg;
	try { msg = JSON.parse(trimmed); } catch { return; }

	// Prompt/follow_up need ack before async work starts
	if (msg.type === "prompt" || msg.type === "follow_up") {
		send({ type: "response", id: msg.id, success: true });
		const text = msg.message || "";
		promptChain = promptChain
			.catch(() => {})
			.then(() => agent.handlePrompt(text))
			.catch(err => {
				console.error("[mock-agent] Prompt error:", err);
			});
		return;
	}

	// Abort needs special handling: response then events
	if (msg.type === "abort") {
		const res = await agent.handleCommand(msg);
		send({ type: "response", id: msg.id, ...res });
		return;
	}

	// All other commands: just reply with result
	const res = await agent.handleCommand(msg);
	send({ type: "response", id: msg.id, ...res });
});

// Signal readiness
send({ type: "session_status", status: "idle" });
