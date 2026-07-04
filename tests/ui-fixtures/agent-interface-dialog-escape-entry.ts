// Test entry for UX-01: pressing Escape to dismiss a confirm/error dialog
// must NOT also abort the streaming agent. Mounts the real <agent-interface>
// (which installs AgentInterface._handleGlobalEscape as a document
// capture-phase keydown listener) alongside a real confirmAction() dialog
// from src/app/dialogs.ts, so the fixture exercises the exact DOM guard the
// production code relies on rather than a mock of it.
import "../../src/ui/components/AgentInterface.js";
import { confirmAction } from "../../src/app/dialogs.js";

type Listener = (event: any) => void | Promise<void>;

class FixtureSession {
	sessionId = "dialog-escape-fixture";
	streamFn: any = Object.assign(async function* () {}, { __isDefault: true });
	getApiKey = async () => "fixture-key";
	private listeners = new Set<Listener>();
	state: any;
	abortCallCount = 0;

	constructor(isStreaming: boolean) {
		this.state = {
			messages: [
				{ id: "u1", role: "user", content: [{ type: "text", text: "Do the thing" }] },
			],
			isStreaming,
			status: isStreaming ? "streaming" : "idle",
			model: { provider: "claude-code", id: "claude-opus-4-8", name: "Claude Code Opus 4.8", runtime: "claude-code", contextWindow: 200_000, reasoning: true },
			thinkingLevel: "off",
			tools: [],
			pendingToolCalls: new Set<string>(),
			streamingMessage: null,
			serverCost: { totalCost: 0 },
			runtime: "claude-code",
		};
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: any): void {
		for (const listener of this.listeners) void listener(event);
	}

	async prompt(_input: string): Promise<void> {}
	abort(): void {
		this.abortCallCount++;
	}
	getQueue(): any[] {
		return [];
	}
}

function installCss(): void {
	if (document.getElementById("agent-interface-dialog-escape-fixture-css")) return;
	const style = document.createElement("style");
	style.id = "agent-interface-dialog-escape-fixture-css";
	style.textContent = `
		:root { --background:#fff; --foreground:#111; --muted:#f3f4f6; --muted-foreground:#4b5563; --border:#d1d5db; --input:#d1d5db; --card:#fff; --popover:#fff; --popover-foreground:#111; --primary:#2563eb; --warning:#f59e0b; --destructive:#ef4444; }
		html, body, #app { height:100%; margin:0; overflow:hidden; }
		body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		#app { width:100vw; height:100vh; }
		agent-interface { display:flex; flex-direction:column; height:100%; min-height:0; }
		.flex { display:flex; } .flex-col { flex-direction:column; } .flex-1 { flex:1 1 0%; } .shrink-0 { flex-shrink:0; } .min-h-0 { min-height:0; }
		message-list, streaming-message-container, user-message, assistant-message, tool-message { display:block; }
		button { font:inherit; }
	`;
	document.head.appendChild(style);
}

let session: FixtureSession | undefined;

async function mountFixture(options: { isStreaming?: boolean } = {}): Promise<void> {
	installCss();
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	app.replaceChildren();
	const el = document.createElement("agent-interface") as any;
	session = new FixtureSession(options.isStreaming !== false);
	el.session = session;
	el.sessionRuntime = "claude-code";
	el.enableModelSelector = false;
	el.enableThinkingSelector = false;
	el.enableAttachments = false;
	el.gitRepoKnown = "no";
	app.appendChild(el);
	await customElements.whenDefined("agent-interface");
	await el.updateComplete;
	(window as any).__agentInterfaceEl = el;
}

let confirmResult: { settled: boolean; value?: boolean } = { settled: false };

function openConfirmDialog(): void {
	confirmResult = { settled: false };
	void confirmAction("Discard changes?", "You have unsaved changes.", "Discard", true).then((value) => {
		confirmResult = { settled: true, value };
	});
}

(window as any).__mountAgentInterfaceDialogEscapeFixture = mountFixture;
(window as any).__openConfirmDialog = openConfirmDialog;
(window as any).__getAbortCallCount = () => session?.abortCallCount ?? 0;
(window as any).__getConfirmResult = () => confirmResult;
(window as any).__agentInterfaceDialogEscapeReady = true;
