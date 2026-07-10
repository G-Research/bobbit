import "../../src/ui/components/AgentInterface.js";
import { streamSimple } from "@earendil-works/pi-ai";

type Listener = (event: any) => void;

let logicalClock = 1;
let mountedInterface: any = null;
let activeSession: PermissionFixtureSession | null = null;

function textMessage(role: "user" | "assistant", text: string, id: string) {
	return {
		id,
		role,
		content: [{ type: "text", text }],
		timestamp: logicalClock++,
	};
}

function permissionRow(id: string, toolName: string, status = "active") {
	return {
		id,
		role: "tool_permission_needed",
		toolName,
		group: "Shell",
		roleName: "coder",
		roleLabel: "Coder",
		lastPromptText: `fixture prompt for ${toolName}`,
		status,
		timestamp: logicalClock++,
	};
}

function longTranscript() {
	const messages: any[] = [];
	for (let i = 0; i < 18; i++) {
		messages.push(textMessage("user", `fixture user message ${i + 1}`, `u-${i}`));
		messages.push(textMessage("assistant", `fixture assistant message ${i + 1}\n${"filler line\n".repeat(5)}`, `a-${i}`));
		if (i === 3) messages.push(permissionRow("perm-bash", "Bash"));
		if (i === 4) messages.push(permissionRow("perm-edit", "Edit"));
	}
	return messages;
}

class PermissionFixtureSession {
	sessionId = "permission-card-ux-fixture";
	streamFn = streamSimple;
	grantCalls: any[] = [];
	denyCalls: any[] = [];
	private listeners = new Set<Listener>();
	state: any = {
		messages: longTranscript(),
		tools: [],
		pendingToolCalls: new Set<string>(),
		streamingMessage: null,
		isStreaming: false,
		status: "idle",
		model: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
		thinkingLevel: "off",
		usage: null,
		cost: 0,
	};

	subscribe(listener: Listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: any) {
		for (const listener of this.listeners) listener(event);
	}

	grantToolPermission(toolName: string, scope: "tool" | "group", group?: string, lastPromptText?: string, mode?: string) {
		this.grantCalls.push({ toolName, scope, group, lastPromptText, mode });
		this.state.messages = this.state.messages.map((m: any) => m.role === "tool_permission_needed" && m.toolName === toolName
			? { ...m, status: "granted", actionable: false }
			: m);
		this.emit({ type: "state_update" });
	}

	denyToolPermission(id: string, toolName?: string) {
		this.denyCalls.push({ id, toolName });
		this.state.messages = this.state.messages.map((m: any) => m.id === id
			? { ...m, status: "denied", actionable: false }
			: m);
		this.emit({ type: "state_update" });
	}

	getQueue() { return []; }
	abort() {}
	async prompt() {}
}

async function nextFrames(frames = 2): Promise<void> {
	for (let i = 0; i < frames; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function settle() {
	await mountedInterface?.updateComplete;
	await nextFrames(2);
}

async function mount() {
	logicalClock = 1;
	activeSession = new PermissionFixtureSession();
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	app.replaceChildren();
	mountedInterface = document.createElement("agent-interface") as any;
	mountedInterface.session = activeSession;
	mountedInterface.gitRepoKnown = "no";
	app.appendChild(mountedInterface);
	await settle();
	(window as any).__permissionCardUxReady = true;
}

function scrollToBottom() {
	const scroller = document.querySelector("agent-interface .overflow-y-auto") as HTMLElement | null;
	if (!scroller) throw new Error("scroll container missing");
	scroller.scrollTop = scroller.scrollHeight;
	scroller.dispatchEvent(new Event("scroll"));
}

function selectors() {
	return {
		pinned: "[data-permission-pinned], [data-pinned-permission-controls], .pinned-permission-controls",
		cards: "[data-permission-pinned] tool-permission-card, [data-pinned-permission-controls] tool-permission-card, .pinned-permission-controls tool-permission-card",
		editor: "message-editor, [data-input-container]",
		scroller: "agent-interface .overflow-y-auto",
	};
}

function geometryProbe() {
	const s = selectors();
	const pinned = document.querySelector(s.pinned) as HTMLElement | null;
	const editor = document.querySelector("message-editor") as HTMLElement | null;
	const scroller = document.querySelector(s.scroller) as HTMLElement | null;
	if (!pinned) return { ok: false, error: "pinned permission controls not visible" };
	if (!editor || !scroller) return { ok: false, error: "editor or scroller missing" };
	const pr = pinned.getBoundingClientRect();
	const er = editor.getBoundingClientRect();
	const sr = scroller.getBoundingClientRect();
	const visible = pr.width > 0 && pr.height > 0 && pr.bottom <= window.innerHeight + 1 && pr.top >= -1;
	const overlapsEditor = !(pr.right <= er.left || pr.left >= er.right || pr.bottom <= er.top || pr.top >= er.bottom);
	const alignedWithEditor = Math.abs(pr.left - er.left) <= 1 && Math.abs(pr.right - er.right) <= 1;
	return { ok: visible && !overlapsEditor && alignedWithEditor, visible, overlapsEditor, alignedWithEditor, pinned: pr.toJSON(), editor: er.toJSON(), scroller: sr.toJSON() };
}

async function remountWithoutReplay() {
	const existing = activeSession;
	if (!existing) throw new Error("fixture not mounted");
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	app.replaceChildren();
	mountedInterface = document.createElement("agent-interface") as any;
	mountedInterface.session = existing;
	mountedInterface.gitRepoKnown = "no";
	app.appendChild(mountedInterface);
	await settle();
}

Object.assign(window as any, {
	__mountPermissionCardUxFixture: mount,
	__scrollPermissionFixtureToBottom: scrollToBottom,
	__permissionFixtureGeometry: geometryProbe,
	__permissionFixtureSelectors: selectors,
	__permissionFixtureSession: () => activeSession,
	__permissionFixtureRemountWithoutReplay: remountWithoutReplay,
});

void mount();
