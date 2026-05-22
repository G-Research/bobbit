import "../../src/ui/components/AgentInterface.js";
import { streamSimple } from "@earendil-works/pi-ai";

type Listener = (event: any) => void | Promise<void>;

class FixtureSession {
	sessionId = "chat-scroll-fixture";
	streamFn = streamSimple;
	getApiKey = async () => "fixture-key";
	private listeners = new Set<Listener>();
	state = {
		messages: [],
		isStreaming: false,
		status: "idle",
		model: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
		thinkingLevel: "off",
		tools: [],
		pendingToolCalls: new Set<string>(),
		streamingMessage: null,
		usage: null,
		cost: 0,
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
	if (document.getElementById("chat-scroll-fixture-css")) return;
	const style = document.createElement("style");
	style.id = "chat-scroll-fixture-css";
	style.textContent = `
		:root { --background:#fff; --foreground:#111; --muted:#f3f4f6; --border:#d1d5db; --input:#d1d5db; }
		html, body, #app { height: 100%; margin: 0; overflow: hidden; }
		body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		#app { width: 1280px; height: 720px; }
		agent-interface { display:flex; flex-direction:column; height:100%; min-height:0; }
		.flex { display:flex; } .inline-flex { display:inline-flex; } .flex-col { flex-direction:column; }
		.flex-1 { flex:1 1 0%; } .shrink-0 { flex-shrink:0; } .min-h-0 { min-height:0; } .min-w-0 { min-width:0; }
		.h-full { height:100%; } .relative { position:relative; } .absolute { position:absolute; } .inset-0 { inset:0; }
		.overflow-y-auto { overflow-y:auto; } .overflow-x-hidden { overflow-x:hidden; }
		.max-w-5xl { max-width:64rem; } .mx-auto { margin-left:auto; margin-right:auto; }
		.p-2 { padding:8px; } .p-4, .sm\\:p-4 { padding:16px; } .pb-0 { padding-bottom:0; }
		.px-2 { padding-left:8px; padding-right:8px; } .px-3 { padding-left:12px; padding-right:12px; }
		.py-1\\.5 { padding-top:6px; padding-bottom:6px; } .pt-0 { padding-top:0; } .pb-1 { padding-bottom:4px; }
		.left-1\/2 { left:50%; } .-translate-x-1\/2 { transform:translateX(-50%); }
		.z-10 { z-index:10; } .items-center { align-items:center; } .gap-1\\.5 { gap:6px; }
		.text-xs { font-size:12px; } .rounded-full { border-radius:9999px; } .border { border:1px solid var(--border); }
		.bg-background { background:var(--background); } .text-foreground { color:var(--foreground); }
		.hover\\:bg-muted:hover { background:var(--muted); } .shadow-sm { box-shadow:0 1px 2px rgba(0,0,0,.08); }
		.whitespace-nowrap { white-space:nowrap; }
		message-list, streaming-message-container { display:block; }
		user-message, assistant-message, tool-message { display:block; margin:8px; padding:12px; border-radius:8px; background:#eef2ff; }
		tool-message { background:#ecfeff; }
		#__tail_chat_pre_spacer, #__jtb_spacer, #__pre_spacer { background:linear-gradient(#eef, #fee); }
	`;
	document.head.appendChild(style);
}

async function mount(): Promise<void> {
	installCss();
	(window as any).fetch = async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
	(window as any).WebSocket = class FixtureWebSocket {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;
		readyState = FixtureWebSocket.OPEN;
		addEventListener(): void {}
		send(): void {}
		close(): void { this.readyState = FixtureWebSocket.CLOSED; }
	};
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	app.replaceChildren();
	const ai = document.createElement("agent-interface") as any;
	ai.session = new FixtureSession();
	ai.readOnly = true;
	ai.nonInteractive = false;
	ai.gitRepoKnown = "no";
	ai.enableAttachments = false;
	ai.enableModelSelector = false;
	ai.enableThinkingSelector = false;
	app.appendChild(ai);
	await customElements.whenDefined("agent-interface");
	await ai.updateComplete;
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	const scroll = document.querySelector("agent-interface .overflow-y-auto");
	if (!scroll) throw new Error("scroll container not mounted");
}

(window as any).__mountChatScrollFixture = mount;
(window as any).__chatScrollReady = true;
