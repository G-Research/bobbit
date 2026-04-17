/**
 * Core mock agent logic, extracted from mock-agent.mjs as a per-session class.
 *
 * Used in two modes:
 *   1. Child-process mode (mock-agent.mjs) — one instance per spawned process,
 *      communicates via stdin/stdout JSONL.
 *   2. In-process mode (in-process-mock-bridge.mjs) — one instance per session,
 *      plugged directly into RpcBridge via the same public API. Skips Node
 *      process spawn, JSONL serialization, and stdio setup per session.
 *
 * Isolation rules:
 *   - All state (messages, model, session file path, abort controller) lives
 *     on the instance — never on module-level globals.
 *   - Environment reads (BOBBIT_SESSION_ID, BOBBIT_DIR, ...) go through the
 *     constructor opts so in-process mode can pass per-session overrides.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

/**
 * @typedef {Object} MockAgentOptions
 * @property {string} [cwd] - Working directory (defaults to process.cwd())
 * @property {Object} [env] - Env-var overrides (defaults to process.env)
 * @property {(event: any) => void} [onEvent] - Event emitter. Required for in-process mode.
 */

export class MockAgentCore {
	/** @param {MockAgentOptions} options */
	constructor(options = {}) {
		this.cwd = options.cwd || process.cwd();
		this.env = options.env || process.env;
		this._onEvent = options.onEvent || (() => {});
		this.conversationMessages = [];
		this.currentModel = { provider: "mock", id: "mock-model", contextWindow: 128000, maxTokens: 16384, reasoning: true };
		this.sessionFilePath = null;
		this.currentAbortController = null;
		// Serializes concurrent handlePrompt calls so a second prompt queued
		// while the first is still in flight runs after the first completes.
		// Mirrors the real agent's sequential stream behaviour, which the
		// team-manager relies on when sending a delegate's initial
		// "Execute the task" prompt followed immediately by the actual task.
		this._promptChain = Promise.resolve();
	}

	/** Override the event emitter (used by child-process mode). */
	setEventEmitter(fn) { this._onEvent = fn; }

	/** Emit an agent event to the listener */
	emit(event) { this._onEvent(event); }

	/** Ensure the session .jsonl file exists and return its path */
	ensureSessionFile() {
		if (this.sessionFilePath) return this.sessionFilePath;
		const agentDir = this.env.BOBBIT_AGENT_DIR
			|| path.join(this.env.HOME || this.env.USERPROFILE || "/tmp", ".bobbit", "agent");
		const slug = this.cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").substring(0, 60) || "--workspace--";
		const dir = path.join(agentDir, "sessions", slug);
		fs.mkdirSync(dir, { recursive: true });
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const uuid = (typeof crypto !== "undefined" && crypto.randomUUID?.()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		this.sessionFilePath = path.join(dir, `${ts}_${uuid}.jsonl`);
		fs.writeFileSync(this.sessionFilePath, "");
		return this.sessionFilePath;
	}

	/** Extract a file path from prompt text (handles Windows and Unix paths) */
	static extractFilePath(text) {
		const winMatch = text.match(/[A-Z]:[\\\/][^\s"']+/);
		if (winMatch) return winMatch[0].replace(/[.,;:!?)]+$/, '');
		const unixMatch = text.match(/\/[\w./-]+/);
		if (unixMatch) return unixMatch[0].replace(/[.,;:!?)]+$/, '');
		return "/tmp/mock-file.txt";
	}

	/** Detect which tool the prompt is asking for and return a canned response */
	static respondToPrompt(text) {
		const lower = text.toLowerCase();

		const toolDeniedMatch = text.match(/TOOL_DENIED:(\S+)/);
		if (toolDeniedMatch) return { toolDenied: toolDeniedMatch[1] };

		if (lower.includes("project_proposal") || lower.includes("project proposal")) {
			return {
				tool: "propose_project",
				input: {
					name: "Test Project",
					root_path: "/tmp/test-project",
					build_command: "npm run build",
					test_command: "npm test",
					typecheck_command: "npm run check",
					worktree_setup_command: "npm ci",
				},
				output: "Project proposal submitted.",
			};
		}

		if (lower.includes("goal_proposal") || lower.includes("goal proposal")) {
			return {
				tool: "propose_goal",
				input: {
					title: "E2E Test Goal",
					workflow: "general",
					options: "QA testing",
					spec: "This is a test goal created via the assistant flow.\nIt validates the goal creation UI.",
				},
				output: "Proposal submitted. Waiting for user response.",
			};
		}

		if (lower.includes("review_multi")) {
			const docs = [
				{ title: "Document A", markdown: "# Document A\n\nFirst document content." },
				{ title: "Document B", markdown: "# Document B\n\nSecond document content." },
				{ title: "Document C", markdown: "# Document C\n\nThird document content." },
			];
			return {
				multiTool: docs.map(d => ({
					tool: "review_open",
					input: { title: d.title, markdown: d.markdown },
					output: JSON.stringify({ action: "review_open", title: d.title, markdown: d.markdown, replace: true }),
				})),
			};
		}
		if (lower.includes("review_open")) {
			const md = "# Test Document\n\nThis is a test document for review.\n\n## Section One\n\nSome important text that could be commented on.\n\n## Section Two\n\nMore content here with `code examples` and details.";
			return {
				tool: "review_open",
				input: { title: "Test Document", markdown: md },
				output: JSON.stringify({ action: "review_open", title: "Test Document", markdown: md, replace: true }),
			};
		}
		if (lower.includes("review_close")) {
			return {
				tool: "review_close",
				input: { title: "Test Document" },
				output: JSON.stringify({ action: "review_close", title: "Test Document" }),
			};
		}

		if (lower.includes("mock_error")) return { mockError: true };

		if (lower.includes("bash") || lower.includes("echo ")) {
			return { tool: "Bash", input: { command: "echo BOBBIT_TOOL_TEST_OK_12345" }, output: "BOBBIT_TOOL_TEST_OK_12345\n" };
		}
		if (lower.includes("write tool") || lower.includes("use the write")) {
			const filePath = MockAgentCore.extractFilePath(text);
			return { tool: "Write", input: { path: filePath, content: "E2E_WRITE_TEST\n" }, output: `Wrote to ${filePath}` };
		}
		if (lower.includes("read tool") || lower.includes("use the read")) {
			const filePath = MockAgentCore.extractFilePath(text);
			return { tool: "Read", input: { path: filePath }, output: "READ_THIS_CONTENT_E2E\n" };
		}
		if (lower.includes("edit tool") || lower.includes("use the edit")) {
			const filePath = MockAgentCore.extractFilePath(text);
			return { tool: "Edit", input: { path: filePath, oldText: "ORIGINAL_VALUE", newText: "EDITED_VALUE" }, output: "Edited successfully" };
		}
		return null;
	}

	/** Small abortable delay */
	tick(ms = 10) {
		return new Promise(r => {
			const timer = setTimeout(r, ms);
			if (this.currentAbortController) {
				this.currentAbortController.signal.addEventListener("abort", () => {
					clearTimeout(timer);
					r();
				});
			}
		});
	}

	/** Simulate a full agent turn: streaming start → tool calls → assistant text → end */
	async handlePrompt(text) {
		this.currentAbortController = new AbortController();

		// Echo back the user message (real agent does this)
		const userMsg = { role: "user", content: [{ type: "text", text }] };
		this.conversationMessages.push(userMsg);
		this.emit({ type: "message_end", message: userMsg });

		// Tiny delay before starting — just enough to mimic a real async
		// boundary without adding significant test wall time. The original
		// 50ms was meant to mirror the real agent's startup latency but
		// tests don't care about that specific number; a microtask boundary
		// is sufficient.
		await this.tick(5);

		// Emit agent lifecycle events
		this.emit({ type: "agent_start" });
		this.emit({ type: "session_status", status: "streaming" });

		await this.tick(5);

		const toolAction = MockAgentCore.respondToPrompt(text);

		if (toolAction && toolAction.toolDenied) {
			await this._handleToolDenied(toolAction.toolDenied);
		} else if (toolAction && toolAction.multiTool) {
			this._handleMultiTool(toolAction.multiTool);
		} else if (toolAction && toolAction.mockError) {
			const assistantMsg = {
				role: "assistant",
				content: [{ type: "text", text: "Error: something went wrong" }],
				stopReason: "error",
			};
			this.conversationMessages.push(assistantMsg);
			this.emit({ type: "message_end", message: assistantMsg });
		} else if (toolAction && toolAction.tool) {
			this._handleSingleTool(toolAction);
		} else if (toolAction && toolAction.text) {
			const assistantMsg = { role: "assistant", content: [{ type: "text", text: toolAction.text }] };
			this.conversationMessages.push(assistantMsg);
			this.emit({ type: "message_end", message: assistantMsg });
		} else {
			// Simple text response with realistic usage data
			const assistantMsg = {
				role: "assistant",
				content: [{ type: "text", text: "OK" }],
				usage: {
					input: 150, output: 25, cacheRead: 0, cacheWrite: 0, totalTokens: 175,
					cost: { input: 0.00045, output: 0.0003, cacheRead: 0, cacheWrite: 0, total: 0.00075 },
				},
			};
			this.conversationMessages.push(assistantMsg);
			this.emit({ type: "message_end", message: assistantMsg });
		}

		// Delay before completing — only stay busy when tests explicitly request it.
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

		if (busyMs > 100) {
			const busyToolId = `tool_busy_${Date.now()}`;
			this.emit({ type: "tool_execution_start", toolName: "Bash", toolId: busyToolId, input: { command: "sleep" } });
			await this.tick(busyMs);
			if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
				this.currentAbortController = null;
				return;
			}
			this.emit({ type: "tool_execution_end", toolCallId: busyToolId, toolName: "Bash", isError: false });
		} else {
			await this.tick(busyMs);
		}

		if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
			this.currentAbortController = null;
			return;
		}
		this.currentAbortController = null;

		this.emit({ type: "agent_end" });
		this.emit({ type: "session_status", status: "idle" });
	}

	async _handleToolDenied(deniedTool) {
		const toolId = `tool_${Date.now()}`;
		this.emit({ type: "tool_execution_start", toolName: deniedTool, toolId, input: {} });

		const sessionId = this.env.BOBBIT_SESSION_ID;
		const bobbitDir = this.env.BOBBIT_DIR || path.join(this.env.HOME || this.env.USERPROFILE || ".", ".bobbit");
		let gwUrl, token;
		try {
			gwUrl = (this.env.BOBBIT_GATEWAY_URL || fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8")).trim();
			token = (this.env.BOBBIT_TOKEN || fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8")).trim();
		} catch (err) {
			const toolResultMsg = {
				role: "toolResult",
				content: [{ type: "text", text: `Error: Tool ${deniedTool} is not allowed for your current role. Ask the user to grant permission.` }],
			};
			this.conversationMessages.push(toolResultMsg);
			this.emit({ type: "message_end", message: toolResultMsg });
			this.emit({ type: "tool_execution_end", toolId, toolName: deniedTool, isError: true });
			this.emit({ type: "agent_end" });
			this.emit({ type: "session_status", status: "idle" });
			return;
		}

		const toolGroup = deniedTool.startsWith("mcp__") ? "MCP: " + deniedTool.split("__")[1] : "unknown";
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
				this.emit({ type: "tool_execution_end", toolId, toolName: deniedTool, isError: false });
				const assistantMsg = {
					role: "assistant",
					content: [{ type: "text", text: `Permission granted for ${deniedTool}. Tool executed successfully.` }],
				};
				this.conversationMessages.push(assistantMsg);
				this.emit({ type: "message_end", message: assistantMsg });
			} else {
				this.emit({ type: "tool_execution_end", toolId, toolName: deniedTool, isError: true });
				const assistantMsg = {
					role: "assistant",
					content: [{ type: "text", text: `I tried to use ${deniedTool} but permission was denied.` }],
				};
				this.conversationMessages.push(assistantMsg);
				this.emit({ type: "message_end", message: assistantMsg });
			}
		} catch (err) {
			this.emit({ type: "tool_execution_end", toolId, toolName: deniedTool, isError: true });
			const assistantMsg = {
				role: "assistant",
				content: [{ type: "text", text: `Error requesting permission for ${deniedTool}: ${err.message}` }],
			};
			this.conversationMessages.push(assistantMsg);
			this.emit({ type: "message_end", message: assistantMsg });
		}
	}

	_handleMultiTool(multiTool) {
		const contentBlocks = [];
		for (const action of multiTool) {
			const toolId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
			this.emit({ type: "tool_execution_start", toolName: action.tool, toolId, input: action.input });
			this.emit({ type: "tool_execution_update", toolId, toolName: action.tool, status: "complete", output: action.output });
			this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName: action.tool, isError: false });
			contentBlocks.push({ type: "toolCall", id: toolId, name: action.tool, arguments: action.input, input: action.input });

			const toolResultMsg = {
				role: "toolResult",
				toolCallId: toolId,
				toolName: action.tool,
				isError: false,
				content: [{ type: "text", text: action.output }],
			};
			this.conversationMessages.push(toolResultMsg);
			this.emit({ type: "message_end", message: toolResultMsg });
		}

		contentBlocks.push({ type: "text", text: `Done. Used ${multiTool.length} tools.` });
		const assistantMsg = { role: "assistant", content: contentBlocks };
		this.conversationMessages.push(assistantMsg);
		this.emit({ type: "message_end", message: assistantMsg });
	}

	_handleSingleTool(toolAction) {
		const toolId = `tool_${Date.now()}`;
		this.emit({ type: "tool_execution_start", toolName: toolAction.tool, toolId, input: toolAction.input });

		if (toolAction.tool === "Write" && toolAction.input.path && toolAction.input.content) {
			try { fs.writeFileSync(toolAction.input.path, toolAction.input.content, "utf-8"); } catch {}
		}
		if (toolAction.tool === "Edit" && toolAction.input.path) {
			try {
				const content = fs.readFileSync(toolAction.input.path, "utf-8");
				fs.writeFileSync(toolAction.input.path, content.replace(toolAction.input.oldText, toolAction.input.newText), "utf-8");
			} catch {}
		}

		this.emit({ type: "tool_execution_update", toolId, toolName: toolAction.tool, status: "complete", output: toolAction.output });
		this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName: toolAction.tool, isError: false });

		const assistantMsg = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: toolId, name: toolAction.tool, arguments: toolAction.input, input: toolAction.input },
				{ type: "text", text: `Done. Used ${toolAction.tool} tool.` },
			],
		};
		this.conversationMessages.push(assistantMsg);
		this.emit({ type: "message_end", message: assistantMsg });

		const toolResultMsg = {
			role: "toolResult",
			toolCallId: toolId,
			toolName: toolAction.tool,
			isError: false,
			content: [{ type: "text", text: toolAction.output }],
		};
		this.conversationMessages.push(toolResultMsg);
		this.emit({ type: "message_end", message: toolResultMsg });
	}

	/** Handle RPC command. Returns response data or undefined. */
	async handleCommand(msg) {
		switch (msg.type) {
			case "prompt":
			case "follow_up": {
				// Respond to ack, then handle prompt async. Serialize onto the
				// per-instance promise chain so concurrent prompts queue up
				// rather than interleave (which would double-assign
				// currentAbortController and scramble event ordering).
				const text = msg.message || "";
				this._promptChain = this._promptChain
					.catch(() => {})
					.then(() => this.handlePrompt(text))
					.catch(err => {
						console.error("[mock-agent-core] Prompt error:", err);
					});
				return { success: true };
			}

			case "steer": {
				const steerMsg = {
					role: "assistant",
					content: [{ type: "text", text: `[STEER_RECEIVED] ${msg.message || msg.text || ""}` }],
				};
				this.conversationMessages.push(steerMsg);
				this.emit({ type: "message_end", message: steerMsg });
				return { success: true };
			}

			case "abort": {
				if (this.currentAbortController) {
					this.currentAbortController.abort();
					this.currentAbortController = null;
				}
				// Emit abort events synchronously — the caller's `await abort()`
				// resolves on the return value below, after which their listener
				// setup (if any) has already been registered via prior calls.
				// In-process listeners are effectively ordered, so emitting here
				// delivers events to all currently-subscribed handlers without
				// racing a subsequent prompt's new abortController.
				this.emit({ type: "agent_end" });
				this.emit({ type: "session_status", status: "idle" });
				return { success: true };
			}

			case "get_state": {
				const sf = this.ensureSessionFile();
				const lines = this.conversationMessages.map(m => JSON.stringify({ type: "message", message: m }));
				fs.writeFileSync(sf, lines.join("\n") + (lines.length ? "\n" : ""));
				return {
					success: true,
					data: {
						status: "idle",
						sessionFile: sf,
						model: this.currentModel,
					},
				};
			}

			case "get_messages":
				return { success: true, data: this.conversationMessages };

			case "set_model": {
				const knownModels = {
					"claude-sonnet-4-20250514": { provider: "anthropic", id: "claude-sonnet-4-20250514", contextWindow: 1_000_000, maxTokens: 16384 },
				};
				const known = knownModels[msg.modelId];
				if (known) {
					this.currentModel = known;
				} else {
					this.currentModel = { provider: msg.provider || "mock", id: msg.modelId || "mock-model", contextWindow: 128000, maxTokens: 16384 };
				}
				return { success: true };
			}

			case "compact":
				return { success: true };

			default:
				return { success: true };
		}
	}
}
