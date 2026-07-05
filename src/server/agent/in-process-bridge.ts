/**
 * SPIKE PROTOTYPE — in-process pi bridge (Wave-5 "in-process bridge" spike).
 *
 * Hosts pi's `AgentSession` directly in the gateway process instead of
 * spawning a `pi-coding-agent` child process, using pi's own in-process
 * embedding SDK (`createAgentSession` / `createReadOnlyTools`, exported from
 * `@earendil-works/pi-coding-agent`'s main entrypoint). See
 * docs/design/in-process-bridge-spike.md for the measured spawn-latency win,
 * the full risk list, and the go/no-go recommendation this file implements.
 *
 * HARD SCOPE LIMITS — do not relax without re-reading the design doc:
 * - Gated behind `BOBBIT_INPROC_BRIDGE=1` (default OFF; unset behavior is
 *   byte-identical). `isInProcessBridgeEligible` checks the env var FIRST
 *   and short-circuits before touching any other option, so
 *   `createSessionBridge` (session-runtime.ts) falls through to
 *   `new RpcBridge(...)` completely unchanged when the flag is unset.
 * - Eligible ONLY for sessions that are `readOnly`, not `sandboxed`, and not
 *   bound to a Docker `containerId`. Code-executing agents (bash/edit/write)
 *   MUST stay out-of-process: in-process on the host, those tools would run
 *   directly against the host filesystem/shell with no container boundary.
 *   See the design doc's "Downside / risk" section.
 * - The tool surface is hard-pinned to `createReadOnlyTools()`
 *   (read/grep/find/ls — no exec, no mutation) regardless of the caller's
 *   configured allowlist. This is a deliberate spike restriction, not a
 *   configurable option — there is nothing here to contain, which is the
 *   whole point of scoping the spike to this session class.
 * - Event-shape parity with the RPC wire protocol is UNVERIFIED. This
 *   prototype forwards `AgentSessionEvent` objects to `onEvent` listeners
 *   as-is; it does not translate them into the exact JSONL shape the child
 *   process emits. `getState`/`getMessages`/the `prompt` ack are shaped to
 *   match `RpcBridge`'s response envelope; nothing else is guaranteed.
 * - Restart persistence / bash_bg re-attach do NOT apply. An in-process
 *   session has no child PID, so it cannot survive a gateway restart — see
 *   the design doc's migration-risk list.
 *
 * This is spike code: it exists to prove the seam and produce a measurable
 * prototype, not to be a complete IRpcBridge implementation. Do not wire
 * additional session classes through it without re-scoping the risk list.
 */
import path from "node:path";
import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	createAgentSession,
	createReadOnlyTools,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { globalAgentDir } from "../bobbit-dir.js";
import type { IRpcBridge, RpcBridgeOptions, RpcEventListener } from "./rpc-bridge.js";

// Eligibility check lives in its own dependency-free module — see
// in-process-bridge-eligibility.ts — so `session-runtime.ts` can import it
// without pulling in the pi SDK. Re-exported here for convenience.
export { isInProcessBridgeEligible } from "./in-process-bridge-eligibility.js";

function parseModelString(modelString: string | undefined): { provider: string; modelId: string } | undefined {
	if (!modelString) return undefined;
	const slash = modelString.indexOf("/");
	if (slash <= 0 || slash === modelString.length - 1) return undefined;
	return { provider: modelString.slice(0, slash), modelId: modelString.slice(slash + 1) };
}

export class InProcessBridge implements IRpcBridge {
	private session: AgentSession | null = null;
	private listeners: RpcEventListener[] = [];
	private _running = false;
	private unsubscribeSession: (() => void) | null = null;

	constructor(private readonly options: RpcBridgeOptions) {}

	get running(): boolean {
		return this._running;
	}

	async start(): Promise<void> {
		const cwd = this.options.cwd || process.cwd();
		// Real, file-backed auth/model config — same source of truth the
		// child-process bridge points pi at via PI_CODING_AGENT_DIR
		// (globalAgentDir()), so this prototype can complete real prompts
		// against whatever models/credentials are already configured.
		const authStorage = AuthStorage.create(path.join(globalAgentDir(), "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, path.join(globalAgentDir(), "models.json"));
		// In-memory only: this spike does not implement transcript
		// persistence/restart-reattach (see HARD SCOPE LIMITS above).
		const sessionManager = SessionManager.inMemory();

		const requestedModel = parseModelString(this.options.initialModel);
		const model = requestedModel
			? modelRegistry.getAll().find(m => m.provider === requestedModel.provider && m.id === requestedModel.modelId)
			: undefined;

		const { session } = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			sessionManager,
			model,
			noTools: "all",
			customTools: createReadOnlyTools(cwd),
		});

		this.session = session;
		this.unsubscribeSession = session.subscribe((event) => this._emit(event));
		this._running = true;
		// Mirror the child-process bridge's initial idle announcement so
		// consumers waiting on a "session ready" style event don't hang.
		this._emit({ type: "session_status", status: "idle" });
	}

	async stop(): Promise<void> {
		if (!this._running) return;
		this._running = false;
		this.unsubscribeSession?.();
		this.unsubscribeSession = null;
		this.session?.dispose();
		this.session = null;
		this.listeners = [];
	}

	onEvent(listener: RpcEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	/** One bad listener must not break the rest — matches RpcBridge's contract. */
	private _emit(event: any): void {
		for (const listener of this.listeners) {
			try { listener(event); } catch { /* non-fatal */ }
		}
	}

	private requireSession(): AgentSession {
		if (!this.session) throw new Error("InProcessBridge (spike prototype): session not started");
		return this.session;
	}

	async prompt(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<any> {
		const session = this.requireSession();
		// Fire-and-forget like the RPC "prompt" command: pi's session.prompt()
		// resolves once the turn is queued/running, not once the full turn
		// completes. Completion is observed via onEvent ("agent_end"), same as
		// child-process bridge callers already do. Errors are caught here
		// (not thrown to the caller) to avoid an unhandled rejection taking
		// down the gateway — a crash/OOM in this path is exactly the
		// "loss of crash isolation" risk documented in the design doc.
		session
			.prompt(text, images?.length ? { images: images.map(i => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })) } : undefined)
			.catch((err) => {
				console.error("[in-process-bridge] prompt error (spike prototype):", err);
			});
		return { success: true };
	}

	async promptWhenReady(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<any> {
		// In-process is ready synchronously after start() returns — no
		// cold-boot polling loop needed (that's the whole spike hypothesis).
		return this.prompt(text, images);
	}

	async steer(text: string): Promise<any> {
		const session = this.requireSession();
		await session.steer(text);
		return { success: true };
	}

	async abort(): Promise<any> {
		const session = this.requireSession();
		await session.abort();
		return { success: true };
	}

	async getState(): Promise<any> {
		const session = this.requireSession();
		return {
			success: true,
			data: {
				status: session.isStreaming ? "streaming" : "idle",
				model: session.model,
				thinkingLevel: session.thinkingLevel,
			},
		};
	}

	async getMessages(): Promise<any> {
		const session = this.requireSession();
		return { success: true, data: session.messages };
	}

	async setModel(provider: string, modelId: string): Promise<any> {
		const session = this.requireSession();
		const model = session.modelRegistry.getAll().find(m => m.provider === provider && m.id === modelId);
		if (!model) return { success: false, error: `Unknown model ${provider}/${modelId}` };
		await session.setModel(model);
		return { success: true };
	}

	async setThinkingLevel(level: string): Promise<any> {
		const session = this.requireSession();
		session.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]);
		return { success: true };
	}

	async compact(): Promise<any> {
		const session = this.requireSession();
		await session.compact();
		return { success: true };
	}

	async waitForReady(): Promise<void> {
		// No cold boot to wait for: construction in start() already blocks
		// until the session is usable (module graph is warm after the first
		// gateway-lifetime load — see design doc measurements).
		this.requireSession();
	}

	async sendCommand(command: Record<string, any>): Promise<any> {
		switch (command.type) {
			case "get_state": return this.getState();
			case "get_messages": return this.getMessages();
			case "prompt": return this.prompt(command.message, command.images);
			case "steer": return this.steer(command.message);
			case "abort": return this.abort();
			case "set_model": return this.setModel(command.provider, command.modelId);
			case "set_thinking_level": return this.setThinkingLevel(command.level);
			case "compact": return this.compact();
			default:
				return { success: false, error: `InProcessBridge (spike prototype): unsupported command "${command.type}"` };
		}
	}
}
