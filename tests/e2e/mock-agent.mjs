#!/usr/bin/env node
/**
 * Mock pi-coding-agent for E2E tests.
 * Speaks the same JSONL stdin/stdout RPC protocol as the real agent.
 * Responds to prompts with deterministic tool calls — no API needed, instant.
 *
 * Usage: node mock-agent.mjs --mode rpc [--cwd ...] [--tools ...]
 */
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const rl = createInterface({ input: process.stdin });

/** Track conversation messages for get_messages */
const conversationMessages = [];

/** Send a JSONL message to stdout */
function send(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

/** Emit an agent event (no request id) */
function emit(event) {
	send(event);
}

/** Extract a file path from prompt text (handles Windows and Unix paths) */
function extractFilePath(text) {
	// Match Windows paths like C:\Users\...\foo.txt or Unix paths like /tmp/foo.txt
	const winMatch = text.match(/[A-Z]:[\\\/][^\s"']+/);
	if (winMatch) return winMatch[0].replace(/[.,;:!?)]+$/, '');
	const unixMatch = text.match(/\/[\w./-]+/);
	if (unixMatch) return unixMatch[0].replace(/[.,;:!?)]+$/, '');
	return "/tmp/mock-file.txt";
}

/** Detect which tool the prompt is asking for and return a canned response */
function respondToPrompt(text) {
	const lower = text.toLowerCase();

	// Detect TOOL_DENIED:<toolName> pattern — emit tool denial events for permission testing
	const toolDeniedMatch = text.match(/TOOL_DENIED:(\S+)/);
	if (toolDeniedMatch) {
		return { toolDenied: toolDeniedMatch[1] };
	}

	// Goal proposal keyword — emit XML-tagged proposal block
	if (lower.includes("goal_proposal") || lower.includes("goal proposal")) {
		return {
			tool: null,
			text: `Here is a goal proposal:\n\n<goal_proposal>\n<title>E2E Test Goal</title>\n<workflow>general</workflow>\n<spec>\nThis is a test goal created via the assistant flow.\nIt validates the goal creation UI.\n</spec>\n</goal_proposal>`
		};
	}

	// Detect tool requests by keywords
	if (lower.includes("bash") || lower.includes("echo ")) {
		return { tool: "Bash", input: { command: "echo BOBBIT_TOOL_TEST_OK_12345" }, output: "BOBBIT_TOOL_TEST_OK_12345\n" };
	}
	if (lower.includes("write tool") || lower.includes("use the write")) {
		const filePath = extractFilePath(text);
		return { tool: "Write", input: { path: filePath, content: "E2E_WRITE_TEST\n" }, output: `Wrote to ${filePath}` };
	}
	if (lower.includes("read tool") || lower.includes("use the read")) {
		const filePath = extractFilePath(text);
		return { tool: "Read", input: { path: filePath }, output: "READ_THIS_CONTENT_E2E\n" };
	}
	if (lower.includes("edit tool") || lower.includes("use the edit")) {
		const filePath = extractFilePath(text);
		return { tool: "Edit", input: { path: filePath, oldText: "ORIGINAL_VALUE", newText: "EDITED_VALUE" }, output: "Edited successfully" };
	}
	// Default: just reply with text
	return null;
}

/** Abort controller for cancellable delays */
let currentAbortController = null;

/** Small async delay to simulate realistic agent timing (abortable) */
const tick = (ms = 10) => new Promise(r => {
	const timer = setTimeout(r, ms);
	if (currentAbortController) {
		currentAbortController.signal.addEventListener("abort", () => {
			clearTimeout(timer);
			r();
		});
	}
});

/** Simulate a full agent turn: streaming start → tool calls → assistant text → end */
async function handlePrompt(requestId, text) {
	currentAbortController = new AbortController();
	// Acknowledge the prompt
	send({ type: "response", id: requestId, success: true });

	// Echo back the user message (real agent does this)
	const userMsg = { role: "user", content: [{ type: "text", text }] };
	conversationMessages.push(userMsg);
	emit({ type: "message_end", message: userMsg });

	// Brief delay before starting — mirrors real agent startup
	await tick(50);

	// Emit agent lifecycle events
	emit({ type: "agent_start" });
	emit({ type: "session_status", status: "streaming" });

	await tick(20);

	const toolAction = respondToPrompt(text);

	if (toolAction && toolAction.toolDenied) {
		// Simulate a tool_call guard requesting permission via the gateway REST endpoint.
		// This triggers the tool_permission_needed WebSocket broadcast to UI clients.
		const deniedTool = toolAction.toolDenied;
		const toolId = `tool_${Date.now()}`;

		// Tool execution start (the agent attempted the tool)
		emit({
			type: "tool_execution_start",
			toolName: deniedTool,
			toolId,
			input: {},
		});

		// POST to the gateway's tool-grant-request endpoint (same as the real guard extension)
		const sessionId = process.env.BOBBIT_SESSION_ID;
		const bobbitDir = process.env.BOBBIT_DIR || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".bobbit");
		let gwUrl, token;
		try {
			gwUrl = (process.env.BOBBIT_GATEWAY_URL || fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8")).trim();
			token = (process.env.BOBBIT_TOKEN || fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8")).trim();
		} catch (err) {
			// Fallback: emit old-style error if gateway credentials unavailable
			const toolResultMsg = {
				role: "toolResult",
				content: [{ type: "text", text: `Error: Tool ${deniedTool} is not allowed for your current role. Ask the user to grant permission.` }],
			};
			conversationMessages.push(toolResultMsg);
			emit({ type: "message_end", message: toolResultMsg });
			emit({ type: "tool_execution_end", toolId, toolName: deniedTool, isError: true });
			emit({ type: "agent_end" });
			emit({ type: "session_status", status: "idle" });
			return;
		}

		// Determine the MCP group name from the tool name (e.g. mcp__mock__echo → "MCP: mock")
		// MCP manager uses "MCP: <serverName>" as the group name
		const toolGroup = deniedTool.startsWith("mcp__")
			? "MCP: " + deniedTool.split("__")[1]
			: "unknown";

		const body = JSON.stringify({ toolName: deniedTool, toolGroup });
		const url = new URL(gwUrl + "/api/sessions/" + sessionId + "/tool-grant-request");

		try {
			const result = await new Promise((resolve, reject) => {
				const req = http.request(url, {
					method: "POST",
					headers: {
						"Authorization": "Bearer " + token,
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(body),
					},
					// Long-poll can take a while if user is slow to respond,
					// but 30s is enough for E2E tests
					timeout: 30_000,
				}, (res) => {
					let data = "";
					res.on("data", (chunk) => data += chunk);
					res.on("end", () => {
						try { resolve(JSON.parse(data)); } catch { resolve({ granted: false }); }
					});
				});
				req.on("timeout", () => { req.destroy(); resolve({ granted: false, reason: "timeout" }); });
				req.on("error", reject);
				req.write(body);
				req.end();
			});

			if (result && result.granted) {
				// Permission was granted — simulate successful tool execution
				emit({ type: "tool_execution_end", toolId, toolName: deniedTool, isError: false });
				const assistantMsg = {
					role: "assistant",
					content: [{ type: "text", text: `Permission granted for ${deniedTool}. Tool executed successfully.` }],
				};
				conversationMessages.push(assistantMsg);
				emit({ type: "message_end", message: assistantMsg });
			} else {
				// Permission denied
				emit({ type: "tool_execution_end", toolId, toolName: deniedTool, isError: true });
				const assistantMsg = {
					role: "assistant",
					content: [{ type: "text", text: `I tried to use ${deniedTool} but permission was denied.` }],
				};
				conversationMessages.push(assistantMsg);
				emit({ type: "message_end", message: assistantMsg });
			}
		} catch (err) {
			emit({ type: "tool_execution_end", toolId, toolName: deniedTool, isError: true });
			const assistantMsg = {
				role: "assistant",
				content: [{ type: "text", text: `Error requesting permission for ${deniedTool}: ${err.message}` }],
			};
			conversationMessages.push(assistantMsg);
			emit({ type: "message_end", message: assistantMsg });
		}
	} else if (toolAction && toolAction.tool) {
		const toolId = `tool_${Date.now()}`;

		// Tool execution start
		emit({
			type: "tool_execution_start",
			toolName: toolAction.tool,
			toolId,
			input: toolAction.input,
		});

		// Actually execute Write and Edit tools for real file system effects
		if (toolAction.tool === "Write" && toolAction.input.path && toolAction.input.content) {
			try { fs.writeFileSync(toolAction.input.path, toolAction.input.content, "utf-8"); } catch { /* best effort */ }
		}
		if (toolAction.tool === "Edit" && toolAction.input.path) {
			try {
				const content = fs.readFileSync(toolAction.input.path, "utf-8");
				fs.writeFileSync(toolAction.input.path, content.replace(toolAction.input.oldText, toolAction.input.newText), "utf-8");
			} catch { /* best effort */ }
		}

		// Tool execution end
		emit({
			type: "tool_execution_update",
			toolId,
			toolName: toolAction.tool,
			status: "complete",
			output: toolAction.output,
		});

		// Assistant message with tool result
		const assistantMsg = {
			role: "assistant",
			content: [
				{ type: "tool_use", id: toolId, name: toolAction.tool, input: toolAction.input },
				{ type: "text", text: `Done. Used ${toolAction.tool} tool.` },
			],
		};
		conversationMessages.push(assistantMsg);
		emit({ type: "message_end", message: assistantMsg });
	} else if (toolAction && toolAction.text) {
		// Custom text response (e.g. goal_proposal)
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: toolAction.text }],
		};
		conversationMessages.push(assistantMsg);
		emit({ type: "message_end", message: assistantMsg });
	} else {
		// Simple text response
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: "OK" }],
		};
		conversationMessages.push(assistantMsg);
		emit({ type: "message_end", message: assistantMsg });
	}

	// Delay before completing — only stay busy when tests explicitly request it.
	// Use "STAY_BUSY:<ms>" in the prompt to request a specific delay (abortable).
	// Legacy keywords ("sleep 120", "working", "first prompt", "long essay") use
	// shorter delays than before to keep the suite fast.
	const lower = text.toLowerCase();
	const busyMatch = text.match(/STAY_BUSY:(\d+)/);
	let busyMs = 10;
	if (busyMatch) {
		busyMs = parseInt(busyMatch[1], 10);
	} else if (lower.includes("sleep 120") || lower.includes("sleep 60")) {
		busyMs = 60000;
	} else if (lower.includes("working") || lower.includes("first prompt") || lower.includes("long essay")) {
		busyMs = 500;
	}
	await tick(busyMs);

	// If aborted during delay, don't emit end events (abort handler already did)
	if (!currentAbortController || currentAbortController.signal.aborted) {
		currentAbortController = null;
		return;
	}
	currentAbortController = null;

	// Agent turn complete
	emit({ type: "agent_end" });
	emit({ type: "session_status", status: "idle" });
}

// Handle RPC commands from stdin
rl.on("line", async (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;

	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}

	switch (msg.type) {
		case "prompt":
		case "follow_up":
			await handlePrompt(msg.id, msg.message || "");
			break;

		case "steer":
			send({ type: "response", id: msg.id, success: true });
			break;

		case "abort":
			if (currentAbortController) {
				currentAbortController.abort();
				currentAbortController = null;
			}
			send({ type: "response", id: msg.id, success: true });
			emit({ type: "agent_end" });
			emit({ type: "session_status", status: "idle" });
			break;

		case "get_state":
			send({ type: "response", id: msg.id, success: true, data: { status: "idle" } });
			break;

		case "get_messages":
			send({ type: "response", id: msg.id, success: true, data: conversationMessages });
			break;

		case "set_model":
			send({ type: "response", id: msg.id, success: true });
			break;

		case "compact":
			send({ type: "response", id: msg.id, success: true });
			break;

		default:
			send({ type: "response", id: msg.id, success: true });
	}
});

// Signal readiness
emit({ type: "session_status", status: "idle" });
