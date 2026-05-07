/**
 * mock-agent-core.mjs — supported user-prompt triggers
 * ====================================================
 *
 * The mock LLM agent inspects the user prompt text for these phrases and
 * selects a canned response pattern. Every trigger emits production-shape
 * events (multi-delta message_update, tool_execution_* lifecycle, role-correct
 * message_end) so any production reducer / state-machine change is exercised
 * by tests that use these triggers.
 *
 * Busy / wait
 * -----------
 *  STAY_BUSY:<ms>           Emit one Bash tool_execution_start, tick <ms>,
 *                           then tool_execution_end. Default for prompts
 *                           with no other trigger is busyMs=10.
 *  STAY_BUSY:propose_<type>:<n>
 *                           Emit N message_update deltas streaming a
 *                           propose_<type> tool_use, then message_end +
 *                           tool_execution_* lifecycle. Stable block id
 *                           so RemoteAgent's _processedProposalIds dedup
 *                           engages.
 *  BG_WAIT:<ms>             Drive the real gateway BgProcessManager:
 *                           POST a `sleep <ceil(ms/1000)>` bg process,
 *                           long-poll wait. abortAllWaits resolves it on
 *                           steer/stop. Multi-delta message_update on both
 *                           the create and wait assistant messages.
 *  BG_WAIT_NOID:<ms>        Synthetic-event variant retained for the
 *                           dual-render regression test. Emits one
 *                           bash_bg.wait toolCall in an assistant
 *                           message_end with NO `id` field, parks for
 *                           <ms> ms, then closes. No real bg process.
 *
 * Bursts
 * ------
 *  MIXED_BURST:<n>          n cycles (1..6) of [propose_goal + BG_WAIT 1.5s].
 *                           Stresses the message-ordering reducer.
 *  STREAM_BURST:<n>         Like MIXED_BURST, plus chunked-text streams
 *                           before (no final message_end) and after each
 *                           bash_bg.wait. Reproduces transient client-state
 *                           bugs cleared by browser refresh.
 *
 * Tools (real fs / shell)
 * -----------------------
 *  Read:<path>              fs.readFileSync(path, "utf-8") → output.
 *  Write:<path>::<content>  Recursive mkdir + writeFileSync.
 *  Edit:<path>::<old>::<new>  read + replace + write.
 *  Bash:<cmd>               execSync(cmd, {cwd, timeout:10_000}).
 *
 * Proposals (assistant-driven)
 * ----------------------------
 *  goal_proposal / goal proposal       → propose_goal
 *  project_proposal / project proposal → propose_project
 *  proposal_burst                      → 3x propose_goal in one turn
 *  GOAL_PROPOSAL_PARITY[_EDIT] / PROJECT_PROPOSAL_PARITY[_EDIT] /
 *  ROLE_PROPOSAL_PARITY[_EDIT] / TOOL_PROPOSAL_PARITY[_EDIT] /
 *  STAFF_PROPOSAL_PARITY[_EDIT]        → UX-parity matrix triggers
 *  EDITABLE_PROPOSAL_INITIAL / EDITABLE_PROPOSAL_EDIT
 *                                      → editable-proposals seed/edit
 *  (See _decideToolAction / respondToPrompt for the full matcher table.)
 *
 * UI primitives
 * -------------
 *  ask_user_choices         Single-select widget.
 *  ask_user_choices_multi   Multi-select widget.
 *
 * Steer (RPC, not a prompt-text trigger)
 * --------------------------------------
 *  Steer commands (handleCommand → case "steer") abort the in-flight turn
 *  and queue a fresh handlePrompt(steeredText), which produces a real
 *  <user-message> in the chat. Tests assert on that transcript event.
 *
 * ----------------------------------------------------------------------
 *
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
import { execSync } from "node:child_process";

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

		// Live-update flow: two consecutive propose_project tool calls in the
		// same turn. Checked BEFORE the more general project_proposal substring
		// match because LIVE_UPDATE_PROPOSAL also contains "proposal".
		if (text.includes("LIVE_UPDATE_PROPOSAL")) {
			return { liveUpdateProposal: true };
		}

		// Per-component config flow: two consecutive propose_project calls.
		// First emits components with `config:` populated; second emits the
		// same components without `config:` (only `commands:`). Tests that
		// the per-component shallow-merge in onProjectProposal preserves the
		// previously-proposed `config` map.
		if (text.includes("COMPONENT_CONFIG_PROPOSAL")) {
			return { componentConfigProposal: true };
		}

		// Multi-component proposal with structured components + workflows.
		if (text.includes("MULTI_COMPONENT_PROPOSAL")) {
			return {
				tool: "propose_project",
				input: {
					name: "Multi Comp Project",
					root_path: "/tmp/multi-comp",
					components: [
						{ name: "api", repo: ".", relative_path: "packages/api", commands: { build: "npm run build:api", test: "npm test --workspace=api" } },
						{ name: "web", repo: ".", relative_path: "packages/web", commands: { build: "npm run build:web", test: "npm test --workspace=web" } },
					],
					workflows: {
						"feature-api": {
							id: "feature-api",
							name: "Feature (api)",
							description: "Feature flow scoped to the api component.",
							gates: [
								{ id: "design-doc", name: "Design Document", verify: [] },
								{ id: "implementation", name: "Implementation", depends_on: ["design-doc"], verify: [] },
							],
						},
						"feature-web": {
							id: "feature-web",
							name: "Feature (web)",
							description: "Feature flow scoped to the web component.",
							gates: [
								{ id: "design-doc", name: "Design Document", verify: [] },
								{ id: "implementation", name: "Implementation", depends_on: ["design-doc"], verify: [] },
							],
						},
						"all-components": {
							id: "all-components",
							name: "All Components",
							description: "Fan-out flow that builds every component in parallel.",
							gates: [
								{ id: "design-doc", name: "Design Document", verify: [] },
								{ id: "implementation", name: "Implementation", depends_on: ["design-doc"], verify: [] },
							],
						},
					},
				},
				output: "Multi-component project proposal submitted.",
			};
		}

		// Editable-proposals + parity matchers must precede the generic
		// `project_proposal` substring match below — EDITABLE_PROPOSAL_*
		// and PROJECT_PROPOSAL_PARITY both contain that substring.
		if (text.includes("EDITABLE_PROPOSAL_INITIAL")) {
			return {
				tool: "propose_project",
				input: {
					name: "Editable",
					root_path: "/tmp/editable",
					build_command: "echo old",
					test_command: "echo test",
				},
				output: "Project proposal seeded with echo old.",
			};
		}
		if (text.includes("EDITABLE_PROPOSAL_EDIT")) {
			return {
				tool: "edit_proposal",
				input: { type: "project", old_text: "echo old", new_text: "echo new" },
				output: "Edit applied.",
			};
		}
		if (text.includes("PROJECT_PROPOSAL_PARITY_EDIT")) {
			return {
				tool: "propose_project",
				input: { name: "Parity Project", root_path: "/tmp/parity-project", build_command: "echo parity-edited" },
				output: "Project proposal partial submitted.",
			};
		}
		if (text.includes("PROJECT_PROPOSAL_PARITY")) {
			return {
				tool: "propose_project",
				input: {
					name: "Parity Project",
					root_path: "/tmp/parity-project",
					build_command: "echo parity",
					test_command: "echo parity-test",
					components: [{ name: "core", repo: ".", commands: { build: "echo build-core" } }],
				},
				output: "Project proposal submitted.",
			};
		}

		// Trigger ONLY on the underscore form so the post-accept SYSTEM
		// notify message ("The user accepted your project proposal...")
		// doesn't retrigger and re-emit, which would re-open the panel
		// after the user dismissed/accepted.
		if (lower.includes("project_proposal")) {
			return {
				tool: "propose_project",
				input: {
					name: "Test Project",
					root_path: "/tmp/test-project",
					build_command: "npm run build",
					test_command: "npm test",
					typecheck_command: "npm run check",
					worktree_setup_command: "npm ci",
					qa_start_command: "npm run dev",
				},
				output: "Project proposal submitted.",
			};
		}

		// Burst of two consecutive `propose_*` tool calls in two separate
		// assistant turns, each followed by a toolResult. Used by ST-DEDUP-02
		// to prove the unified message-ordering reducer keeps both widgets in
		// order without overwriting (regression: legacy single-slot deferred
		// assistant message overwrote the first widget when the second arrived).
		if (lower.includes("proposal_burst")) {
			return { proposalBurst: true };
		}

		// UX-parity matrix triggers for assistant-only types (workflow / role /
		// tool / staff). _PARITY emits a full propose_<type>; _PARITY_EDIT emits
		// a partial that touches one scalar so mergeFields preservation is
		// exercised. Goal + project parity triggers live above (they must precede
		// the generic substring matchers).
		if (text.includes("GOAL_PROPOSAL_PARITY_EDIT")) {
			return {
				tool: "propose_goal",
				input: { title: "Parity Goal A — edited", spec: "Body B." },
				output: "Goal proposal partial submitted.",
			};
		}
		if (text.includes("GOAL_PROPOSAL_PARITY")) {
			return {
				tool: "propose_goal",
				input: { title: "Parity Goal A", workflow: "general", spec: "Body A.", cwd: "/tmp/parity-goal" },
				output: "Goal proposal submitted.",
			};
		}
		if (text.includes("ROLE_PROPOSAL_PARITY_EDIT")) {
			return {
				tool: "propose_role",
				input: { name: "parity-role", label: "parity-role-edited", prompt: "P", tools: "", accessory: "none" },
				output: "Role proposal partial submitted.",
			};
		}
		if (text.includes("ROLE_PROPOSAL_PARITY")) {
			return {
				tool: "propose_role",
				input: { name: "parity-role", label: "Parity Role", prompt: "Parity prompt body.", tools: "", accessory: "none" },
				output: "Role proposal submitted.",
			};
		}
		if (text.includes("TOOL_PROPOSAL_PARITY_EDIT")) {
			return {
				tool: "propose_tool",
				input: { tool: "parity-tool", action: "docs", content: "parity-tool-edited content" },
				output: "Tool proposal partial submitted.",
			};
		}
		if (text.includes("TOOL_PROPOSAL_PARITY")) {
			return {
				tool: "propose_tool",
				input: { tool: "parity-tool", action: "docs", content: "Parity tool docs." },
				output: "Tool proposal submitted.",
			};
		}
		if (text.includes("STAFF_PROPOSAL_PARITY_EDIT")) {
			return {
				tool: "propose_staff",
				input: { name: "parity-staff", description: "parity-staff-edited", prompt: "P", triggers: "[]", cwd: "" },
				output: "Staff proposal partial submitted.",
			};
		}
		if (text.includes("STAFF_PROPOSAL_PARITY")) {
			return {
				tool: "propose_staff",
				input: { name: "parity-staff", description: "Parity staff description.", prompt: "Parity staff prompt.", triggers: "[]", cwd: "" },
				output: "Staff proposal submitted.",
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

		// Preview snapshot trigger for tests — must precede review_open matching
		// (the substring "review_open" occurs inside "preview_open").
		const previewMatch = text.match(/PREVIEW_OPEN_SNAPSHOT\s+SIZE=(\d+)/);
		if (previewMatch) {
			const size = Math.max(1, parseInt(previewMatch[1], 10));
			const body = "<!DOCTYPE html><html><body>" + "x".repeat(size) + "</body></html>";
			return { previewSnapshot: body };
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

		// Autonomous skill activation: drives the activate_skill tool path.
		// Trigger phrase: "please activate_skill <name> [args...]" (case-insensitive).
		const activateMatch = text.match(/please\s+activate_skill\s+([\w-]+)(?:\s+([\s\S]*))?$/i);
		if (activateMatch) {
			return {
				activateSkill: { name: activateMatch[1], args: (activateMatch[2] || "").trim() },
			};
		}

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
		if (lower.includes("ask_user_choices_multi")) {
			return { askUserChoices: "multi" };
		}
		if (lower.includes("ask_user_choices") || lower.includes("ask user choices")) {
			// Signals the mock agent to emit a non-blocking ask_user_choices tool_use.
			// The tool returns {status:"posted", tool_use_id} synchronously; answers arrive
			// later as a tagged user message via POST /api/internal/user-question/submit.
			return { askUserChoices: true };
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

		// Non-blocking ask_user_choices: if this prompt is the envelope user
		// message carrying answers, echo them as an assistant text reply so E2E
		// tests can observe the round-trip, then end the turn.
		if (/^\[ask_user_choices_response tool_use_id=/.test(text)) {
			await this._handleAskResponseEnvelope(text);
			await this.tick(5);
			if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
				this.currentAbortController = null;
				return;
			}
			this.currentAbortController = null;
			this.emit({ type: "agent_end" });
			this.emit({ type: "session_status", status: "idle" });
			return;
		}

		// BG_WAIT_NOID:<ms> — emit an assistant message_end with a single
		// bash_bg.wait toolCall block AND no `id` field on the message itself,
		// mimicking the real LLM stream that triggers the dual-render bug.
		// The toolCall id is stable so the synthetic-id fallback
		// `synth:tc:<id>` is deterministic. Used by
		// tests/e2e/ui/bg-wait-no-dup.spec.ts. Distinct from BG_WAIT:<ms>
		// (real-process flow, handled below) because the regression specifically
		// targets the synthetic-event timing where message_end races ahead of
		// the pendingToolCalls update.
		const bgWaitNoidMatch = text.match(/BG_WAIT_NOID:(\d+)/);
		if (bgWaitNoidMatch) {
			const waitMs = parseInt(bgWaitNoidMatch[1], 10);
			const toolId = "tc-bg-wait-1";
			const assistantMsg = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: toolId, name: "bash_bg", arguments: { action: "wait", id: "bg-1" }, input: { action: "wait", id: "bg-1" } },
				],
			};
			// message_update first — sets `state.streamingMessage` on the client so
			// the StreamingMessageContainer renders the in-flight card. The 100ms
			// settle gives Lit's requestAnimationFrame batch in StreamingMessageContainer
			// time to commit before the message_end fires.
			this.emit({ type: "message_update", message: assistantMsg });
			await this.tick(150);
			// NOTE: deliberately do NOT emit tool_execution_start. The bug surface is
			// the dual-render of the same toolCall row in `state.messages` AND in
			// `state.streamingMessage`. When the toolCall is in `pendingToolCalls`,
			// MessageList hides it via `hidePendingToolCalls`, masking the bug; here
			// we simulate the production timing where message_end races ahead of the
			// pending-set update.
			// Assistant message_end WITHOUT an `id` — reproduces the bug condition.
			// The pre-fix path stamps streamingMessageId=undefined, the visible-messages
			// filter short-circuits, and the same card renders in BOTH message-list
			// and StreamingMessageContainer.
			this.conversationMessages.push(assistantMsg);
			this.emit({ type: "message_end", message: assistantMsg });
			// Park here — no further events until waitMs elapses, mirroring a real
			// `bash_bg.wait` that sits indefinitely.
			await this.tick(waitMs);
			if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
				this.currentAbortController = null;
				return;
			}
			this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName: "bash_bg", isError: false });
			this.currentAbortController = null;
			this.emit({ type: "agent_end" });
			this.emit({ type: "session_status", status: "idle" });
			return;
		}

		// Streaming proposal driver — STAY_BUSY:propose_<type>:<n>.
		// Emits N message_update deltas (each with a single tool_use whose input
		// grows on each delta), then message_end + tool_execution_* + agent_end.
		// Block id is stable so RemoteAgent's _processedProposalIds dedup engages.
		const proposeStreamMatch = text.match(/STAY_BUSY:propose_([a-z]+):(\d+)/);
		if (proposeStreamMatch) {
			await this._handleStreamingProposal(proposeStreamMatch[1], parseInt(proposeStreamMatch[2], 10));
			if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
				this.currentAbortController = null;
				return;
			}
			this.currentAbortController = null;
			this.emit({ type: "agent_end" });
			this.emit({ type: "session_status", status: "idle" });
			return;
		}

		const toolAction = MockAgentCore.respondToPrompt(text);

		if (toolAction && toolAction.toolDenied) {
			await this._handleToolDenied(toolAction.toolDenied);
		} else if (toolAction && toolAction.askUserChoices) {
			await this._handleAskUserChoices(toolAction.askUserChoices === "multi");
		} else if (toolAction && toolAction.liveUpdateProposal) {
			await this._handleLiveUpdateProposal();
		} else if (toolAction && toolAction.componentConfigProposal) {
			await this._handleComponentConfigProposal();
		} else if (toolAction && toolAction.activateSkill) {
			await this._handleActivateSkill(toolAction.activateSkill);
		} else if (toolAction && toolAction.proposalBurst) {
			await this._handleProposalBurst();
		} else if (toolAction && toolAction.multiTool) {
			this._handleMultiTool(toolAction.multiTool);
		} else if (toolAction && toolAction.previewSnapshot) {
			this._handlePreviewSnapshot(toolAction.previewSnapshot);
		} else if (toolAction && toolAction.mockError) {
			const assistantMsg = {
				role: "assistant",
				content: [{ type: "text", text: "Error: something went wrong" }],
				stopReason: "error",
			};
			this.conversationMessages.push(assistantMsg);
			this.emit({ type: "message_end", message: assistantMsg });
		} else if (toolAction && toolAction.tool) {
			await this._handleSingleTool(toolAction);
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
		// BG_WAIT:<ms> — drive the REAL gateway BgProcessManager via REST.
		const bgWaitMatch = text.match(/BG_WAIT:(\d+)/);
		// MIXED_BURST:N — N alternating (propose_goal, real bash_bg create+wait) cycles.
		const mixedBurstMatch = text.match(/MIXED_BURST:(\d+)/);
		// STREAM_BURST:N — like MIXED_BURST plus chunked-text streams around each wait.
		const streamBurstMatch = text.match(/STREAM_BURST:(\d+)/);
		let busyMs = 10;
		if (bgWaitMatch) {
			busyMs = parseInt(bgWaitMatch[1], 10);
		} else if (busyMatch) {
			busyMs = parseInt(busyMatch[1], 10);
		} else if (lower.includes("sleep 120") || lower.includes("sleep 60")) {
			busyMs = 60000;
		} else if (lower.includes("working") || lower.includes("first prompt") || lower.includes("long essay")) {
			busyMs = 500;
		}

		if (streamBurstMatch) {
			const n = Math.max(1, Math.min(6, parseInt(streamBurstMatch[1], 10)));
			await this._handleStreamBurst(n);
			if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
				this.currentAbortController = null;
				return;
			}
		} else if (mixedBurstMatch) {
			const n = Math.max(1, Math.min(6, parseInt(mixedBurstMatch[1], 10)));
			await this._handleMixedBurst(n);
			if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
				this.currentAbortController = null;
				return;
			}
		} else if (bgWaitMatch && busyMs > 100) {
			// Drive the REAL gateway BgProcessManager via the same REST endpoints
			// the production bash_bg extension uses. This means a real OS `sleep`
			// runs server-side, the pill strip in the UI engages, and the wait
			// long-poll resolves via the production code path —
			// SessionManager._dispatchSteeredMessages calls bg.abortAllWaits which
			// aborts the registered AbortController for this very HTTP request.
			await this._handleRealBgWait(busyMs);
			if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
				this.currentAbortController = null;
				return;
			}
		} else if (busyMs > 100) {
			const busyToolId = `tool_busy_${Date.now()}`;
			this.emit({ type: "tool_execution_start", toolName: "Bash", toolId: busyToolId, input: { command: "sleep" } });
			await this.tick(busyMs);
			if (!this.currentAbortController || this.currentAbortController.signal.aborted) {
				// Real-agent fidelity (MOCK_ABORT_TOOL_END=1): the bash tool
				// extension emits tool_execution_end on abort because the
				// underlying bash process is killed. Default mock returns
				// early for backwards compatibility with existing tests.
				if (this.env.MOCK_ABORT_TOOL_END === "1") {
					this.emit({ type: "tool_execution_end", toolCallId: busyToolId, toolName: "Bash", isError: true });
				}
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

	/**
	 * Mock the activate_skill tool: call the gateway endpoint to get the
	 * expanded skill body, then emit the same shape of events the real
	 * extension would produce — a toolCall in an assistant message plus a
	 * toolResult carrying `details.skillExpansion` so the UI's
	 * ActivateSkillRenderer renders a <skill-chip>.
	 */
	async _handleActivateSkill({ name, args }) {
		const toolId = `tool_act_${Date.now()}`;
		const input = { name, ...(args ? { args } : {}) };
		this.emit({ type: "tool_execution_start", toolName: "activate_skill", toolId, input });

		const sessionId = this.env.BOBBIT_SESSION_ID;
		const bobbitDir = this.env.BOBBIT_DIR
			|| path.join(this.env.HOME || this.env.USERPROFILE || ".", ".bobbit");
		let gwUrl, token;
		try {
			gwUrl = (this.env.BOBBIT_GATEWAY_URL
				|| fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8")).trim();
			token = (this.env.BOBBIT_TOKEN
				|| fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8")).trim();
		} catch {
			gwUrl = null;
		}

		let expanded = "";
		let source, filePath, isError = false, errMsg = "";
		if (gwUrl && sessionId) {
			try {
				const body = JSON.stringify({ name, args: args || "" });
				const result = await new Promise((resolve, reject) => {
					const u = new URL(`${gwUrl}/api/sessions/${sessionId}/activate-skill`);
					const req = http.request(u, {
						method: "POST",
						headers: {
							"Authorization": `Bearer ${token}`,
							"Content-Type": "application/json",
							"Content-Length": Buffer.byteLength(body),
						},
						timeout: 10_000,
					}, (res) => {
						let data = "";
						res.on("data", (c) => data += c);
						res.on("end", () => {
							try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
							catch { resolve({ status: res.statusCode, body: { error: data } }); }
						});
					});
					req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: { error: "timeout" } }); });
					req.on("error", reject);
					req.write(body);
					req.end();
				});
				if (result.status === 200 && result.body?.ok) {
					expanded = result.body.expanded || "";
					source = result.body.source;
					filePath = result.body.filePath;
				} else {
					isError = true;
					errMsg = result.body?.error || `HTTP ${result.status}`;
				}
			} catch (err) {
				isError = true;
				errMsg = err?.message || String(err);
			}
		} else {
			isError = true;
			errMsg = "gateway credentials unavailable";
		}

		this.emit({
			type: "tool_execution_update",
			toolId,
			toolName: "activate_skill",
			status: "complete",
			output: isError ? `activate_skill failed: ${errMsg}` : expanded,
		});
		this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName: "activate_skill", isError });

		const assistantMsg = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: toolId, name: "activate_skill", arguments: input, input },
				{ type: "text", text: isError ? `Skill activation failed: ${errMsg}` : `Activated /${name}.` },
			],
		};
		this.conversationMessages.push(assistantMsg);
		this.emit({ type: "message_end", message: assistantMsg });

		const toolResultMsg = {
			role: "toolResult",
			toolCallId: toolId,
			toolName: "activate_skill",
			isError,
			content: [{ type: "text", text: isError ? `activate_skill failed: ${errMsg}` : expanded }],
			details: isError
				? undefined
				: { skillExpansion: { name, args: args || "", source, filePath, expanded } },
		};
		this.conversationMessages.push(toolResultMsg);
		this.emit({ type: "message_end", message: toolResultMsg });
	}

	/**
	 * Mixed burst: emit N alternating (propose_goal assistant turn, bash_bg
	 * create+wait pair) cycles in a single turn. Each propose_goal emits a
	 * full assistant message + toolResult; each bash_bg cycle drives the real
	 * gateway BgProcessManager via REST and waits ~1.5s. This is the exact
	 * event-mix that historically caused proposal widgets to duplicate or
	 * land out of order — the unified message-ordering reducer in
	 * src/app/message-reducer.ts is the production code under test.
	 */
	async _handleMixedBurst(n) {
		for (let i = 0; i < n; i++) {
			if (this.currentAbortController?.signal.aborted) return;

			// ── propose_goal turn ─────────────────────────────────
			const propToolId = `tool_burst_${Date.now()}_${i}_${Math.random().toString(36).slice(2,5)}`;
			const propInput = {
				title: `Burst Goal ${i + 1}`,
				workflow: "general",
				spec: `proposal #${i + 1} in mixed burst`,
			};
			this.emit({ type: "tool_execution_start", toolName: "propose_goal", toolId: propToolId, input: propInput });
			const propAssistantMsg = {
				role: "assistant",
				content: [
					{ type: "text", text: `Proposing goal ${i + 1} of ${n}…` },
					{ type: "toolCall", id: propToolId, name: "propose_goal", arguments: propInput, input: propInput },
				],
			};
			this.conversationMessages.push(propAssistantMsg);
			this.emit({ type: "message_update", message: propAssistantMsg });
			await this.tick(20);
			this.emit({ type: "message_end", message: propAssistantMsg });
			const propOutput = `Proposal (${propInput.title}) submitted.`;
			this.emit({ type: "tool_execution_update", toolId: propToolId, toolName: "propose_goal", status: "complete", output: propOutput });
			this.emit({ type: "tool_execution_end", toolCallId: propToolId, toolName: "propose_goal", isError: false });
			const propResultMsg = {
				role: "toolResult",
				toolCallId: propToolId,
				toolName: "propose_goal",
				isError: false,
				content: [{ type: "text", text: propOutput }],
			};
			this.conversationMessages.push(propResultMsg);
			this.emit({ type: "message_end", message: propResultMsg });

			if (this.currentAbortController?.signal.aborted) return;

			// ── bash_bg create + wait (real, ~1.5s) ──────────────────
			await this._handleRealBgWait(1500);
		}

		if (this.currentAbortController?.signal.aborted) return;
		const doneMsg = { role: "assistant", content: [{ type: "text", text: `MIXED_BURST_DONE:${n}` }] };
		this.conversationMessages.push(doneMsg);
		this.emit({ type: "message_end", message: doneMsg });
	}

	/**
	 * Like _handleMixedBurst, but each cycle interleaves a chunked-streamed
	 * assistant text BETWEEN the proposal and the bash_bg.wait, then a
	 * second chunked-streamed text AFTER the wait. Reproduces transient
	 * client-side message duplication / out-of-order rendering bugs.
	 */
	async _handleStreamBurst(n) {
		for (let i = 0; i < n; i++) {
			if (this.currentAbortController?.signal.aborted) return;

			// 1. propose_goal turn
			const propToolId = `tool_sburst_${Date.now()}_${i}_${Math.random().toString(36).slice(2,5)}`;
			const propInput = {
				title: `Stream Goal ${i + 1}`,
				workflow: "general",
				spec: `proposal #${i + 1} in stream burst`,
			};
			this.emit({ type: "tool_execution_start", toolName: "propose_goal", toolId: propToolId, input: propInput });
			const propAssistantMsg = {
				role: "assistant",
				content: [
					{ type: "text", text: `Proposing stream goal ${i + 1} of ${n}…` },
					{ type: "toolCall", id: propToolId, name: "propose_goal", arguments: propInput, input: propInput },
				],
			};
			this.conversationMessages.push(propAssistantMsg);
			this.emit({ type: "message_update", message: propAssistantMsg });
			await this.tick(20);
			this.emit({ type: "message_end", message: propAssistantMsg });
			const propOutput = `Proposal (${propInput.title}) submitted.`;
			this.emit({ type: "tool_execution_update", toolId: propToolId, toolName: "propose_goal", status: "complete", output: propOutput });
			this.emit({ type: "tool_execution_end", toolCallId: propToolId, toolName: "propose_goal", isError: false });
			const propResultMsg = {
				role: "toolResult",
				toolCallId: propToolId,
				toolName: "propose_goal",
				isError: false,
				content: [{ type: "text", text: propOutput }],
			};
			this.conversationMessages.push(propResultMsg);
			this.emit({ type: "message_end", message: propResultMsg });

			if (this.currentAbortController?.signal.aborted) return;

			// 2. Pre-wait chunked streamed text — deliberately omit the final
			//    message_end, mimicking the LLM abandoning partial text to
			//    pivot to a tool_use.
			await this._streamChunkedText(`PRE-WAIT-CHUNK-${i + 1}`, 30, { omitFinalEnd: true });

			if (this.currentAbortController?.signal.aborted) return;

			// 3. Real bash_bg create + wait (~1.5s).
			await this._handleRealBgWait(1500);

			if (this.currentAbortController?.signal.aborted) return;

			// 4. Post-wait chunked streamed text — finalises so next iteration
			//    starts clean.
			await this._streamChunkedText(`POST-WAIT-CHUNK-${i + 1}`, 30);
		}

		if (this.currentAbortController?.signal.aborted) return;
		const doneMsg = { role: "assistant", content: [{ type: "text", text: `STREAM_BURST_DONE:${n}` }] };
		this.conversationMessages.push(doneMsg);
		this.emit({ type: "message_end", message: doneMsg });
	}

	/**
	 * Stream chunked assistant text.
	 * @param label string  prefix for each chunk so they're identifiable in the report
	 * @param chunkCount number  how many message_update events to emit
	 * @param opts.omitFinalEnd boolean  when true, do NOT emit the final message_end.
	 * @param opts.omitId boolean  when true, do NOT include `id` on the message_update payloads.
	 */
	async _streamChunkedText(label, chunkCount, opts = {}) {
		const msgId = opts.omitId ? undefined : `msg_stream_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
		let acc = "";
		for (let i = 0; i < chunkCount; i++) {
			if (this.currentAbortController?.signal.aborted) return;
			const chunk = `[${label}#${String(i + 1).padStart(2, "0")}] `;
			acc += chunk;
			const partial = {
				role: "assistant",
				content: [{ type: "text", text: acc }],
			};
			if (msgId) partial.id = msgId;
			this.emit({ type: "message_update", message: partial });
			await this.tick(8);
		}
		if (opts.omitFinalEnd) return;
		const finalMsg = {
			role: "assistant",
			content: [{ type: "text", text: acc }],
		};
		if (msgId) finalMsg.id = msgId;
		this.conversationMessages.push(finalMsg);
		this.emit({ type: "message_end", message: finalMsg });
	}

	/**
	 * Drive a real bash_bg create+wait via the gateway REST API the production
	 * bash_bg extension uses. The pill strip above the composer engages because
	 * a real BgProcessManager entry exists; the long-poll wait is resolved by
	 * SessionManager.abortAllWaits via the production code path on steer/stop.
	 * Multi-delta message_update on both the create and wait assistant
	 * messages so the reducer / streaming-message-id code paths exercise the
	 * realistic real-LLM event shape.
	 */
	async _handleRealBgWait(durationMs) {
		const sessionId = this.env.BOBBIT_SESSION_ID;
		const bobbitDir = this.env.BOBBIT_DIR
			|| path.join(this.env.HOME || this.env.USERPROFILE || ".", ".bobbit");
		let gwUrl, token;
		try {
			gwUrl = (this.env.BOBBIT_GATEWAY_URL
				|| fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8")).trim();
			token = (this.env.BOBBIT_TOKEN
				|| fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8")).trim();
		} catch {
			gwUrl = null;
		}
		if (!gwUrl || !sessionId) {
			// Out-of-process / unit-test usage — fall back to a plain tick.
			await this.tick(durationMs);
			return;
		}

		const gwReq = (method, p, body) => new Promise((resolve, reject) => {
			const u = new URL(`${gwUrl}${p}`);
			const payload = body ? JSON.stringify(body) : null;
			const headers = { "Authorization": `Bearer ${token}` };
			if (payload) {
				headers["Content-Type"] = "application/json";
				headers["Content-Length"] = Buffer.byteLength(payload);
			}
			const opts = {
				method,
				hostname: u.hostname,
				port: u.port,
				path: u.pathname + (u.search || ""),
				headers,
				timeout: Math.max(durationMs * 2, 30_000),
			};
			const req = http.request(opts, (res) => {
				let data = "";
				res.on("data", (c) => data += c);
				res.on("end", () => {
					try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
					catch { resolve({ status: res.statusCode, body: { error: data } }); }
				});
			});
			req.on("error", reject);
			req.on("timeout", () => { req.destroy(new Error("timeout")); });
			if (payload) req.write(payload);
			req.end();
		});

		// ── 1. CREATE ────────────────────────────────────────────
		const createToolId = `tool_bgcreate_${Date.now()}`;
		const sleepSecs = Math.max(1, Math.ceil(durationMs / 1000));
		const command = `sleep ${sleepSecs}`;
		const name = "long task";
		const createInput = { action: "create", name, command };
		this.emit({ type: "tool_execution_start", toolName: "bash_bg", toolId: createToolId, input: createInput });
		const createAssistantMsg = {
			role: "assistant",
			content: [{ type: "toolCall", id: createToolId, name: "bash_bg", arguments: createInput, input: createInput }],
		};
		this.conversationMessages.push(createAssistantMsg);
		// Real LLM agents stream the toolCall input progressively via
		// multiple message_update deltas before the final message_end.
		const NUM_CREATE_DELTAS = 4;
		for (let i = 0; i < NUM_CREATE_DELTAS; i++) {
			this.emit({ type: "message_update", message: createAssistantMsg });
			await this.tick(20);
		}
		this.emit({ type: "message_end", message: createAssistantMsg });

		let bgId;
		try {
			const createResp = await gwReq("POST", `/api/sessions/${sessionId}/bg-processes`, { command, name });
			if (createResp.status !== 201 || !createResp.body?.id) {
				throw new Error(`bg create failed: ${createResp.status} ${JSON.stringify(createResp.body)}`);
			}
			bgId = createResp.body.id;
		} catch (err) {
			const msg = `bg create error: ${err?.message || err}`;
			this.emit({ type: "tool_execution_update", toolId: createToolId, toolName: "bash_bg", status: "complete", output: msg });
			this.emit({ type: "tool_execution_end", toolCallId: createToolId, toolName: "bash_bg", isError: true });
			return;
		}

		const createOutput = `ID: ${bgId} (${name})`;
		this.emit({ type: "tool_execution_update", toolId: createToolId, toolName: "bash_bg", status: "complete", output: createOutput });
		this.emit({ type: "tool_execution_end", toolCallId: createToolId, toolName: "bash_bg", isError: false });
		const createResultMsg = {
			role: "toolResult",
			toolCallId: createToolId,
			toolName: "bash_bg",
			isError: false,
			content: [{ type: "text", text: createOutput }],
		};
		this.conversationMessages.push(createResultMsg);
		this.emit({ type: "message_end", message: createResultMsg });

		// ── 2. WAIT (long-poll — abortAllWaits resolves it on steer/stop) ───
		const waitToolId = `tool_bgwait_${Date.now()}`;
		const waitInput = { action: "wait", id: bgId, name };
		this.emit({ type: "tool_execution_start", toolName: "bash_bg", toolId: waitToolId, input: waitInput });
		const waitAssistantMsg = {
			role: "assistant",
			content: [{ type: "toolCall", id: waitToolId, name: "bash_bg", arguments: waitInput, input: waitInput }],
		};
		this.conversationMessages.push(waitAssistantMsg);
		// Multi-delta is critical — see PR #436. The 6-delta count is
		// load-bearing for the dual-render repro condition; do not lower it.
		const NUM_WAIT_DELTAS = 6;
		for (let i = 0; i < NUM_WAIT_DELTAS; i++) {
			this.emit({ type: "message_update", message: waitAssistantMsg });
			await this.tick(20);
		}
		this.emit({ type: "message_end", message: waitAssistantMsg });

		let waitResp;
		const waitTimeoutSecs = Math.max(10, Math.ceil(durationMs / 1000) + 5);
		try {
			waitResp = await gwReq("GET", `/api/sessions/${sessionId}/bg-processes/${bgId}/wait?timeout=${waitTimeoutSecs}`);
		} catch (err) {
			waitResp = { status: 0, body: { error: err?.message || String(err) } };
		}

		const localAborted = !this.currentAbortController || this.currentAbortController.signal.aborted;
		const bodyAborted = !!(waitResp?.body && (waitResp.body.aborted || waitResp.body.cancelled));
		const aborted = localAborted || bodyAborted;
		const waitOutput = aborted
			? `wait aborted for ${bgId}`
			: (waitResp?.body?.exitCode != null ? `${bgId} exited with code ${waitResp.body.exitCode}` : `${bgId} done`);

		this.emit({ type: "tool_execution_update", toolId: waitToolId, toolName: "bash_bg", status: "complete", output: waitOutput });
		this.emit({ type: "tool_execution_end", toolCallId: waitToolId, toolName: "bash_bg", isError: aborted });
		const waitResultMsg = {
			role: "toolResult",
			toolCallId: waitToolId,
			toolName: "bash_bg",
			isError: aborted,
			content: [{ type: "text", text: waitOutput }],
		};
		this.conversationMessages.push(waitResultMsg);
		this.emit({ type: "message_end", message: waitResultMsg });

		if (aborted) {
			// Best-effort kill so the OS `sleep` doesn't outlive the test.
			try { await gwReq("DELETE", `/api/sessions/${sessionId}/bg-processes/${bgId}`); } catch { /* ignore */ }
		}
	}

	async _handleAskUserChoices(multi = false) {
		// Non-blocking model: the ask_user_choices tool returns immediately with
		// a `{status:"posted", tool_use_id}` stub and the turn ends. The user's
		// answers arrive in a *later* prompt as an envelope user message — see
		// `_handleAskResponseEnvelope` below.
		const toolId = `tool_ask_${Date.now()}`;

		const questions = multi
			? [
				{ question: "Which colors?", options: ["red", "blue", "green"], multi: true, tab_label: "Colors" },
				{ question: "Team size?", options: ["small", "medium", "large"], tab_label: "Team size" },
			]
			: [
				{ question: "Favorite color?", options: ["red", "blue", "green"], tab_label: "Color" },
				{ question: "Team size?", options: ["small", "medium", "large"], tab_label: "Team size" },
			];

		this.emit({ type: "tool_execution_start", toolName: "ask_user_choices", toolId, input: { questions } });

		const assistantMsg = {
			role: "assistant",
			content: [{ type: "toolCall", id: toolId, name: "ask_user_choices", arguments: { questions }, input: { questions } }],
		};
		this.conversationMessages.push(assistantMsg);
		this.emit({ type: "message_update", message: assistantMsg });
		await this.tick(20);
		this.emit({ type: "message_update", message: assistantMsg });
		await this.tick(20);
		this.emit({ type: "message_end", message: assistantMsg });

		// Stub tool_result — ends the turn immediately.
		const stub = { status: "posted", tool_use_id: toolId };
		const resultText = JSON.stringify(stub);
		this.emit({ type: "tool_execution_update", toolId, toolName: "ask_user_choices", status: "complete", output: resultText });
		this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName: "ask_user_choices", isError: false });

		const toolResultMsg = {
			role: "toolResult",
			toolCallId: toolId,
			toolName: "ask_user_choices",
			isError: false,
			content: [{ type: "text", text: resultText }],
		};
		this.conversationMessages.push(toolResultMsg);
		this.emit({ type: "message_end", message: toolResultMsg });
	}

	/**
	 * Handle a `[ask_user_choices_response tool_use_id=...]` envelope user
	 * message. Parse the JSON body and echo the answers back as an assistant
	 * text message so E2E tests can observe the round-trip.
	 */
	async _handleAskResponseEnvelope(text) {
		const m = /^\[ask_user_choices_response tool_use_id=([A-Za-z0-9_-]+)\]\n([\s\S]+)$/.exec(text);
		if (!m) return;
		const toolUseId = m[1];
		let answers = null;
		try { answers = JSON.parse(m[2]).answers; } catch { /* ignore */ }
		const echo = JSON.stringify({ gotAnswersFor: toolUseId, answers });
		const assistantMsg = { role: "assistant", content: [{ type: "text", text: echo }] };
		this.conversationMessages.push(assistantMsg);
		this.emit({ type: "message_end", message: assistantMsg });
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

	/**
	 * Burst two consecutive `propose_*` tool-call assistant turns followed by
	 * matching toolResults. Each propose_* assistant turn is its own message
	 * (so the legacy `_deferredAssistantMessage` slot would have overwritten
	 * the first when the second arrived); the unified reducer keeps both
	 * widgets in chronological order keyed by their tool_use id.
	 */
	async _handleProposalBurst() {
		const proposals = [
			{
				tool: "propose_goal",
				input: {
					title: "Burst Goal A",
					workflow: "general",
					spec: "first proposal in the burst",
				},
			},
			{
				tool: "propose_role",
				input: {
					name: "burst-role-b",
					label: "Burst Role B",
					prompt: "second proposal in the burst",
					tools: "",
					accessory: "none",
				},
			},
		];
		for (const p of proposals) {
			const toolId = `tool_burst_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
			const toolName = p.tool;
			this.emit({ type: "tool_execution_start", toolName, toolId, input: p.input });
			const assistantMsg = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: toolId, name: toolName, arguments: p.input, input: p.input },
				],
			};
			this.conversationMessages.push(assistantMsg);
			this.emit({ type: "message_update", message: assistantMsg });
			await this.tick(5);
			this.emit({ type: "message_end", message: assistantMsg });

			const output = `${toolName} proposal accepted`;
			this.emit({ type: "tool_execution_update", toolId, toolName, status: "complete", output });
			this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName, isError: false });
			const toolResultMsg = {
				role: "toolResult",
				toolCallId: toolId,
				toolName,
				isError: false,
				content: [{ type: "text", text: output }],
			};
			this.conversationMessages.push(toolResultMsg);
			this.emit({ type: "message_end", message: toolResultMsg });
			await this.tick(5);
		}
		const finalMsg = {
			role: "assistant",
			content: [{ type: "text", text: "BURST_DONE_E2E" }],
		};
		this.conversationMessages.push(finalMsg);
		this.emit({ type: "message_end", message: finalMsg });
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

	_handlePreviewSnapshot(html) {
		const toolId = `tool_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
		const input = { html };
		this.emit({ type: "tool_execution_start", toolName: "preview_open", toolId, input });
		this.emit({ type: "tool_execution_update", toolId, toolName: "preview_open", status: "complete", output: "Preview panel is open and will auto-update." });
		this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName: "preview_open", isError: false });

		const assistantMsg = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: toolId, name: "preview_open", arguments: input, input },
				{ type: "text", text: "Opened preview." },
			],
		};
		this.conversationMessages.push(assistantMsg);
		this.emit({ type: "message_end", message: assistantMsg });

		const toolResultMsg = {
			role: "toolResult",
			toolCallId: toolId,
			toolName: "preview_open",
			isError: false,
			content: [
				{ type: "text", text: "Preview panel is open and will auto-update." },
				{ type: "text", text: "__preview_snapshot_v1__\n" + html },
			],
		};
		this.conversationMessages.push(toolResultMsg);
		this.emit({ type: "message_end", message: toolResultMsg });
	}

	/** Live-update test driver: emit two consecutive propose_project tool
	 *  calls in the same turn. The first carries components only; the second
	 *  carries the same components plus a workflows map. This proves the
	 *  client merges structured side-tables across calls (Bug C live-update
	 *  fix) and re-renders the panel for each call. */
	async _handleLiveUpdateProposal() {
		const components = [
			{ name: "api", repo: ".", relative_path: "packages/api", commands: { build: "npm run build:api" } },
			{ name: "web", repo: ".", relative_path: "packages/web", commands: { build: "npm run build:web" } },
		];
		const firstInput = {
			name: "Live Update Project",
			root_path: "/tmp/live-update",
			components,
		};
		const secondInput = {
			name: "Live Update Project",
			root_path: "/tmp/live-update",
			components,
			workflows: {
				"feature-api": {
					id: "feature-api",
					name: "Feature (api)",
					description: "Feature flow scoped to the api component.",
					gates: [
						{ id: "design-doc", name: "Design Document", verify: [] },
						{ id: "implementation", name: "Implementation", depends_on: ["design-doc"], verify: [] },
					],
				},
				"feature-web": {
					id: "feature-web",
					name: "Feature (web)",
					description: "Feature flow scoped to the web component.",
					gates: [
						{ id: "design-doc", name: "Design Document", verify: [] },
						{ id: "implementation", name: "Implementation", depends_on: ["design-doc"], verify: [] },
					],
				},
			},
		};

		const emitOne = (input, label) => {
			const toolId = `tool_propose_project_${label}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
			this.emit({ type: "tool_execution_start", toolName: "propose_project", toolId, input });
			const assistantMsg = {
				role: "assistant",
				content: [{ type: "toolCall", id: toolId, name: "propose_project", arguments: input, input }],
			};
			this.conversationMessages.push(assistantMsg);
			this.emit({ type: "message_end", message: assistantMsg });
			const output = `Proposal (${label}) submitted.`;
			this.emit({ type: "tool_execution_update", toolId, toolName: "propose_project", status: "complete", output });
			this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName: "propose_project", isError: false });
			const toolResultMsg = {
				role: "toolResult",
				toolCallId: toolId,
				toolName: "propose_project",
				isError: false,
				content: [{ type: "text", text: output }],
			};
			this.conversationMessages.push(toolResultMsg);
			this.emit({ type: "message_end", message: toolResultMsg });
		};

		emitOne(firstInput, "first");
		await this.tick(60);
		emitOne(secondInput, "second");
	}

	async _handleComponentConfigProposal() {
		// First call: components carry `config:` populated with qa_* keys.
		const firstInput = {
			name: "CompConfig Project",
			root_path: "/tmp/comp-config",
			components: [
				{
					name: "web",
					repo: ".",
					commands: { build: "npm run build", test: "npm test" },
					config: {
						qa_start_command: "PORT=$PORT NODE_ENV=test npm start",
						qa_health_check: "http://127.0.0.1:$PORT/health",
						qa_max_duration_minutes: "10",
					},
				},
				{ name: "api", repo: ".", commands: { build: "npm run build:api" } },
			],
		};
		// Second call: same components but WITHOUT `config:` — the per-component
		// shallow merge in session-manager.onProjectProposal must preserve the
		// previously-proposed `config` map on web.
		const secondInput = {
			name: "CompConfig Project",
			root_path: "/tmp/comp-config",
			components: [
				{ name: "web", repo: ".", commands: { build: "npm run build", test: "npm test" } },
				{ name: "api", repo: ".", commands: { build: "npm run build:api" } },
			],
		};

		const emitOne = (input, label) => {
			const toolId = `tool_propose_project_${label}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
			this.emit({ type: "tool_execution_start", toolName: "propose_project", toolId, input });
			const assistantMsg = {
				role: "assistant",
				content: [{ type: "toolCall", id: toolId, name: "propose_project", arguments: input, input }],
			};
			this.conversationMessages.push(assistantMsg);
			this.emit({ type: "message_end", message: assistantMsg });
			const output = `Proposal (${label}) submitted.`;
			this.emit({ type: "tool_execution_update", toolId, toolName: "propose_project", status: "complete", output });
			this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName: "propose_project", isError: false });
			const toolResultMsg = {
				role: "toolResult",
				toolCallId: toolId,
				toolName: "propose_project",
				isError: false,
				content: [{ type: "text", text: output }],
			};
			this.conversationMessages.push(toolResultMsg);
			this.emit({ type: "message_end", message: toolResultMsg });
		};

		emitOne(firstInput, "first");
		await this.tick(60);
		emitOne(secondInput, "second");
	}

	/** Stream a propose_<type> tool_use across N message_update deltas, then
	 *  emit message_end + tool_execution_start/end. */
	async _handleStreamingProposal(type, n) {
		const toolId = `tool_propose_${type}_${Date.now()}`;
		const toolName = `propose_${type}`;
		// Per-type input shape — keep the title/name field stable after first delta.
		const paragraph = (i) => `Paragraph ${i}: ` + "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(2);
		const growSpec = (count) => Array.from({ length: count }, (_, i) => paragraph(i + 1)).join("\n\n");
		const buildInput = (deltaIdx) => {
			const grown = growSpec(deltaIdx + 1);
			switch (type) {
				case "goal":
					return { title: "E2E Streaming Goal", workflow: "general", spec: grown };
				case "role":
					return { name: "e2e-stream-role", label: "E2E Stream Role", prompt: grown, tools: "", accessory: "none" };
				case "tool":
					return { tool: "e2e_stream_tool", action: "docs", content: grown };
				case "staff":
					return { name: "e2e-stream-staff", description: "E2E", prompt: grown, triggers: "[]", cwd: "" };
				case "setup":
					return { action: "system-prompt", content: grown };
				case "workflow":
					return { id: "e2e-stream-wf", name: "E2E Stream Workflow", description: grown, gates: "[]" };
				case "project":
					return { name: "E2E Stream Project", root_path: "/tmp/e2e-stream", build_command: "npm run build" };
				default:
					return { spec: grown };
			}
		};

		for (let i = 0; i < n; i++) {
			if (this.currentAbortController?.signal.aborted) return;
			const input = buildInput(i);
			const assistantMsg = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: toolId, name: toolName, arguments: input, input },
				],
			};
			this.emit({ type: "message_update", message: assistantMsg });
			await this.tick(60);
		}

		if (this.currentAbortController?.signal.aborted) return;

		// Final message_end carries the complete tool_use block.
		const finalInput = buildInput(n - 1);
		const finalMsg = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: toolId, name: toolName, arguments: finalInput, input: finalInput },
			],
		};
		this.conversationMessages.push(finalMsg);
		this.emit({ type: "message_end", message: finalMsg });

		this.emit({ type: "tool_execution_start", toolName, toolId, input: finalInput });
		const output = "Proposal submitted.";
		this.emit({ type: "tool_execution_update", toolId, toolName, status: "complete", output });
		this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName, isError: false });

		const toolResultMsg = {
			role: "toolResult",
			toolCallId: toolId,
			toolName,
			isError: false,
			content: [{ type: "text", text: output }],
		};
		this.conversationMessages.push(toolResultMsg);
		this.emit({ type: "message_end", message: toolResultMsg });
	}

	async _handleSingleTool(toolAction) {
		const toolId = `tool_${Date.now()}`;
		this.emit({ type: "tool_execution_start", toolName: toolAction.tool, toolId, input: toolAction.input });

		// Run the actual tool effect against the real filesystem / shell where
		// possible. The chat card shows whatever string we put in `output`, so
		// downstream tests can assert on real file contents and real exit codes.
		let output = toolAction.output;
		let isError = false;
		try {
			if (toolAction.tool === "Write" && toolAction.input.path && typeof toolAction.input.content === "string") {
				fs.mkdirSync(path.dirname(toolAction.input.path), { recursive: true });
				fs.writeFileSync(toolAction.input.path, toolAction.input.content, "utf-8");
				output = `Wrote ${Buffer.byteLength(toolAction.input.content, "utf-8")} bytes to ${toolAction.input.path}`;
			} else if (toolAction.tool === "Edit" && toolAction.input.path) {
				const content = fs.readFileSync(toolAction.input.path, "utf-8");
				const next = content.replace(toolAction.input.oldText, toolAction.input.newText);
				fs.writeFileSync(toolAction.input.path, next, "utf-8");
				output = next === content ? `Edit no-op (oldText not found)` : `Edited ${toolAction.input.path}`;
			} else if (toolAction.tool === "Read" && toolAction.input.path) {
				output = fs.readFileSync(toolAction.input.path, "utf-8");
			} else if (toolAction.tool === "Bash" && toolAction.input.command) {
				// Real shell. Use cwd so commands resolve relative paths correctly.
				output = execSync(toolAction.input.command, { cwd: this.cwd, encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
			}
		} catch (err) {
			isError = true;
			output = `${toolAction.tool} error: ${err?.message || err}`;
		}

		// propose_* tools: mirror the real extension's seed POST so the file-on-disk
		// source of truth (Slice B) is populated during E2E. Awaited so the seed
		// completes before message_end fires — the rehydrate path on reload depends
		// on the file already existing.
	let revMarker = undefined;
		if (typeof toolAction.tool === "string" && toolAction.tool.startsWith("propose_")) {
			revMarker = await this._seedProposal(toolAction.tool.slice("propose_".length), toolAction.input);
		}
		// edit_proposal tool: shell to the gateway edit endpoint so the file
		// updates and the server broadcasts proposal_update {source:"edit"}.
		if (toolAction.tool === "edit_proposal" && toolAction.input?.type) {
			revMarker = await this._editProposal(
				toolAction.input.type,
				toolAction.input.old_text ?? "",
				toolAction.input.new_text ?? "",
			);
		}
		let effectiveOutput = output;
		if (typeof revMarker === "number" && revMarker > 0) {
			effectiveOutput = `${effectiveOutput}\n__proposal_rev_v1__:${revMarker}`;
		}

		this.emit({ type: "tool_execution_update", toolId, toolName: toolAction.tool, status: "complete", output: effectiveOutput });
		this.emit({ type: "tool_execution_end", toolCallId: toolId, toolName: toolAction.tool, isError });

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
			isError,
			content: [{ type: "text", text: effectiveOutput }],
		};
		this.conversationMessages.push(toolResultMsg);
		this.emit({ type: "message_end", message: toolResultMsg });
	}

	/** Resolve the gateway URL+token. Returns null when unavailable. */
	_gatewayCreds() {
		const sessionId = this.env.BOBBIT_SESSION_ID;
		const bobbitDir = this.env.BOBBIT_DIR
			|| path.join(this.env.HOME || this.env.USERPROFILE || ".", ".bobbit");
		try {
			const gwUrl = (this.env.BOBBIT_GATEWAY_URL
				|| fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8")).trim();
			const token = (this.env.BOBBIT_TOKEN
				|| fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8")).trim();
			if (!sessionId || !gwUrl || !token) return null;
			return { sessionId, gwUrl, token };
		} catch {
			return null;
		}
	}

	/** Generic gateway POST helper used by seed / edit endpoints. */
	_gatewayPost(pathname, body) {
		const creds = this._gatewayCreds();
		if (!creds) return Promise.resolve(null);
		const { gwUrl, token } = creds;
		const payload = JSON.stringify(body);
		return new Promise((resolve) => {
			try {
				const u = new URL(`${gwUrl}${pathname}`);
				const req = http.request(u, {
					method: "POST",
					headers: {
						"Authorization": `Bearer ${token}`,
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(payload),
					},
					timeout: 5_000,
				}, (res) => {
					let buf = "";
					res.on("data", (chunk) => { buf += chunk.toString(); });
					res.on("end", () => {
						try { resolve(buf ? JSON.parse(buf) : null); } catch { resolve(null); }
					});
				});
				req.on("timeout", () => { req.destroy(); resolve(null); });
				req.on("error", () => resolve(null));
				req.write(payload);
				req.end();
			} catch { resolve(null); }
		});
	}

	async _seedProposal(type, args) {
		const creds = this._gatewayCreds();
		if (!creds) return undefined;
		const body = await this._gatewayPost(`/api/sessions/${creds.sessionId}/proposal/${type}/seed`, { args });
		return body && typeof body === "object" && typeof body.rev === "number" ? body.rev : undefined;
	}

	async _editProposal(type, oldText, newText) {
		const creds = this._gatewayCreds();
		if (!creds) return undefined;
		const body = await this._gatewayPost(`/api/sessions/${creds.sessionId}/proposal/${type}/edit`, {
			old_text: oldText,
			new_text: newText,
		});
		return body && typeof body === "object" && typeof body.rev === "number" ? body.rev : undefined;
	}

	/** Handle RPC command. Returns response data or undefined. */
	async handleCommand(msg) {
		switch (msg.type) {
			case "prompt":
			case "follow_up": {
				// Real-agent fidelity (MOCK_ABORT_BUSY=1): reject prompts that
				// arrive in the same microtask as agent_end-from-abort, mirroring
				// pi-agent-core's "Agent is already processing." guard.
				if (this._busyOverride) {
					return { success: false, error: "Agent is already processing." };
				}
				// A fresh prompt restarts the loop — clear the abort window.
				this._abortedRecently = false;
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
				// Production behaviour: steer interrupts the current turn and
				// the steered text becomes a fresh user prompt with its own
				// assistant turn. Tests scan the rendered chat for a
				// <user-message> matching the steered text — we get that by
				// queueing a real handlePrompt round-trip after the in-flight
				// turn finishes.
				//
				// Crucially we do NOT null out currentAbortController here:
				// the in-flight handlePrompt is still on the call stack and
				// observes signal.aborted via that reference. Clearing it makes
				// loop-iteration aborted-checks read undefined and keep running,
				// which lets the in-flight burst overlap with the steered
				// handlePrompt and corrupts ordering.
				const steeredText = msg.message || msg.text || "";
				if (this.currentAbortController) {
					this.currentAbortController.abort();
				}

				// Real-agent fidelity (MOCK_STEER_QUEUE_DROP=1): the SDK queues
				// steer text on `_steeringMessages` and only consumes it at the
				// start of the NEXT loop iteration. If the agent loop has just
				// been aborted (and won't iterate again until a fresh prompt()),
				// the steer text is silently dropped — the SDK accepts the RPC
				// but the message never surfaces as a <user-message>. Default
				// mock immediately runs handlePrompt(steeredText), which always
				// surfaces the message; that hides this real-agent failure mode.
				if (this.env.MOCK_STEER_QUEUE_DROP === "1" && this._abortedRecently) {
					return { success: true };
				}

				if (steeredText) {
					this._promptChain = this._promptChain
						.catch(() => {})
						.then(() => this.handlePrompt(steeredText))
						.catch(err => {
							console.error("[mock-agent-core] Steered prompt error:", err);
						});
				}
				return { success: true };
			}

			case "abort": {
				if (this.currentAbortController) {
					this.currentAbortController.abort();
					this.currentAbortController = null;
				}
				// MOCK_STEER_QUEUE_DROP fidelity: mark a window during which steer
				// RPCs return success but their text is dropped (matching SDK
				// behaviour where _steeringMessages is populated but the loop
				// has exited). Cleared on the next prompt() so a fresh user
				// turn (which restarts the loop) processes steers normally.
				if (this.env.MOCK_STEER_QUEUE_DROP === "1") {
					this._abortedRecently = true;
				}
				// Real-agent fidelity (MOCK_ABORT_BUSY=1): the SDK emits agent_end
				// from `handleRunFailure` while `activeRun` is still set; only the
				// outer try/finally's `finishRun()` clears it on the next microtask.
				// A synchronous prompt() call from an agent_end listener (e.g.
				// drainQueue calling rpcClient.prompt) therefore rejects with
				// "Agent is already processing." Setting _busyOverride here for one
				// microtask reproduces that exact race — cleared via setImmediate so
				// any deferred drain (microtask / setImmediate / setTimeout) succeeds.
				if (this.env.MOCK_ABORT_BUSY === "1") {
					this._busyOverride = true;
					setImmediate(() => { this._busyOverride = false; });
				}
				// Emit abort events synchronously — the caller's `await abort()`
				// resolves on the return value below, after which their listener
				// setup (if any) has already been registered via prior calls.
				// In-process listeners are effectively ordered, so emitting here
				// delivers events to all currently-subscribed handlers without
				// racing a subsequent prompt's new abortController.
				//
				// Real-agent fidelity: when the user aborts an in-flight turn, the
				// real Claude bridge surfaces the abort by emitting an assistant
				// `message_end` with `stopReason:"error"` (rendered as "Request
				// aborted" in the UI) BEFORE the terminal `agent_end`. This is the
				// signal that flips `session.lastTurnErrored=true` in the server,
				// which then gates `drainQueue` off in the `agent_end` handler.
				// The MOCK_ABORT_AS_ERROR opt-in switches the mock to that shape so
				// tests can exercise the error-gated drain path without changing
				// the default abort behaviour for tests that rely on the clean
				// (non-errored) abort.
				if (this.env.MOCK_ABORT_AS_ERROR === "1") {
					const abortedMsg = {
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: "Request aborted",
					};
					this.emit({ type: "message_end", message: abortedMsg });
				}
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
