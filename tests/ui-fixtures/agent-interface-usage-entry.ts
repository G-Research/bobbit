import "../../src/ui/components/AgentInterface.js";

type Listener = (event: any) => void | Promise<void>;

class FixtureSession {
	sessionId = "claude-usage-fixture";
	streamFn: any = Object.assign(async function* () {}, { __isDefault: true });
	getApiKey = async () => "fixture-key";
	private listeners = new Set<Listener>();
	state: any = {
		messages: [
			{ id: "u1", role: "user", content: [{ type: "text", text: "Read the file and summarize it" }] },
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "I'll inspect it." }, { type: "toolCall", id: "toolu_reported_1", toolCallId: "toolu_reported_1", name: "Read", arguments: { file_path: "README.md" }, input: { file_path: "README.md" } }] },
			{ id: "tr1", role: "toolResult", toolCallId: "toolu_reported_1", toolName: "Read", isError: false, content: [{ type: "text", text: "# README\nBobbit project notes" }] },
			{
				id: "a2",
				role: "assistant",
				content: [{ type: "text", text: "The file contains Bobbit project notes." }],
				stopReason: "stop",
				usage: {
					input_tokens: 301,
					cache_creation_input_tokens: 6415,
					cache_read_input_tokens: 13231,
					output_tokens: 77,
					server_tool_use: { web_search_requests: 0 },
					service_tier: "standard",
				},
			},
		],
		isStreaming: false,
		status: "idle",
		model: { provider: "claude-code", id: "claude-opus-4-8", name: "Claude Code Opus 4.8", runtime: "claude-code", contextWindow: 200_000, reasoning: true },
		thinkingLevel: "off",
		tools: [],
		pendingToolCalls: new Set<string>(),
		streamingMessage: null,
		serverCost: { totalCost: 0 },
	};

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: any): void {
		for (const listener of this.listeners) void listener(event);
	}

	async prompt(_input: string): Promise<void> {}
	abort(): void {}
	getQueue(): any[] { return []; }
}

function installCss(): void {
	if (document.getElementById("agent-interface-usage-fixture-css")) return;
	const style = document.createElement("style");
	style.id = "agent-interface-usage-fixture-css";
	style.textContent = `
		:root { --background:#fff; --foreground:#111; --muted:#f3f4f6; --muted-foreground:#4b5563; --border:#d1d5db; --input:#d1d5db; --card:#fff; --popover:#fff; --popover-foreground:#111; --primary:#2563eb; --warning:#f59e0b; --destructive:#ef4444; }
		html, body, #app { height:100%; margin:0; overflow:hidden; }
		body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		#app { width:100vw; height:100vh; }
		agent-interface { display:flex; flex-direction:column; height:100%; min-height:0; }
		.flex { display:flex; } .inline-flex { display:inline-flex; } .flex-col { flex-direction:column; } .flex-1 { flex:1 1 0%; } .shrink-0 { flex-shrink:0; } .min-h-0 { min-height:0; } .min-w-0 { min-width:0; }
		.h-full { height:100%; } .relative { position:relative; } .absolute { position:absolute; } .inset-0 { inset:0; } .overflow-y-auto { overflow-y:auto; } .overflow-x-hidden { overflow-x:hidden; } .max-w-5xl { max-width:64rem; } .mx-auto { margin-left:auto; margin-right:auto; }
		.p-2 { padding:8px; } .p-4, .sm\\:p-4 { padding:16px; } .pb-0 { padding-bottom:0; } .px-2 { padding-left:8px; padding-right:8px; } .pt-0 { padding-top:0; } .pb-1 { padding-bottom:4px; }
		.items-center { align-items:center; } .justify-between { justify-content:space-between; } .gap-1 { gap:4px; } .gap-1\\.5 { gap:6px; } .gap-2 { gap:8px; } .gap-3 { gap:12px; } .text-xs { font-size:12px; } .text-sm { font-size:14px; }
		.bg-background { background:var(--background); } .text-foreground { color:var(--foreground); } .text-muted-foreground { color:var(--muted-foreground); } .truncate { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .cursor-pointer { cursor:pointer; } .transition-colors { transition:color 150ms ease; }
		message-list, streaming-message-container, user-message, assistant-message, tool-message { display:block; }
		user-message, assistant-message, tool-message { margin:8px; padding:12px; border-radius:8px; background:#eef2ff; }
		tool-message { background:#ecfeff; }
		button { font:inherit; }
	`;
	document.head.appendChild(style);
}

async function mountFixture(): Promise<void> {
	installCss();
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	app.replaceChildren();
	const el = document.createElement("agent-interface") as any;
	el.session = new FixtureSession();
	el.sessionRuntime = "claude-code";
	el.enableModelSelector = false;
	el.enableThinkingSelector = false;
	el.enableAttachments = false;
	el.gitRepoKnown = "no";
	app.appendChild(el);
	await customElements.whenDefined("agent-interface");
	await el.updateComplete;
	(window as any).__agentInterfaceUsageEl = el;
}

(window as any).__mountAgentInterfaceUsageFixture = mountFixture;
(window as any).__agentInterfaceUsageReady = true;
