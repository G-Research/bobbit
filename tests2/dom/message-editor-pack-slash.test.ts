import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/message-editor-pack-slash.spec.ts (v2-dom tier).
// Renders the REAL <message-editor> with the client pack launcher registry
// (registerPackEntrypoints + setLauncherHostFactory), replacing the esbuild
// file:// bundle. Pins typed pack composer-slash dispatch: a full-line
// `/pr-walkthrough <arg>` send routes through the launcher (never onSend), while
// autocomplete selection only completes the slash token so args can be added.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";
import { registerPackEntrypoints } from "../../src/app/pack-entrypoints.js";
import { setLauncherHostFactory } from "../../src/app/pack-panels.js";

// See message-editor-ctrl-arrow.test.ts: re-register the tag in this file's window
// under vitest isolate:false.
if (!customElements.get("message-editor")) customElements.define("message-editor", MessageEditor);

type CallRouteCall = { route: string; sessionId: string | undefined; packId: string; contributionId: string; body?: unknown };

let sendCalls: Array<{ text: string; attachmentCount: number }>;
let callRouteCalls: CallRouteCall[];
let messageSendEvents: string[];
let launcherFeedbackEvents: Array<{ kind?: string; message?: string }>;
let feedbackListener: (e: Event) => void;
let slashSkills: any[];

function installPrWalkthroughLauncher(): void {
	installLaunchers([
		{
			id: "pr-walkthrough",
			packId: "pr-walkthrough",
			kind: "composer-slash",
			label: "PR Walkthrough",
			target: { action: "spawn", route: "run", panelId: "pr-walkthrough.panel" },
		},
	]);
}

function installLaunchers(entries: any[]): void {
	callRouteCalls = [];
	registerPackEntrypoints(entries as any, "project-a");
	setLauncherHostFactory((sessionId: string | undefined, packId: string, contributionId: string) => ({
		capabilities: { callRoute: true } as any,
		callRoute: async (route: string, init?: { body?: unknown }) => {
			callRouteCalls.push({ route, sessionId, packId, contributionId, body: init?.body });
			return { ok: true, childSessionId: "child-pr", jobId: "job-pr" };
		},
		ui: { openPanel: () => { /* not needed */ } },
	}) as any);
}

function mount(installDefaultLauncher = true): any {
	sendCalls = [];
	messageSendEvents = [];
	if (installDefaultLauncher) installPrWalkthroughLauncher();
	const el = document.createElement("message-editor") as any;
	el.sessionId = "pack-slash-session";
	el.cwd = "/tmp";
	el.showAttachmentButton = false;
	el.showModelSelector = false;
	el.showThinkingSelector = false;
	el.onSend = (text: string, attachments: unknown[]) => sendCalls.push({ text, attachmentCount: attachments.length });
	el.addEventListener("message-send", () => { messageSendEvents.push(el.value); });
	document.body.appendChild(el);
	return el;
}

const textarea = (el: any): HTMLTextAreaElement => el.querySelector("textarea");

async function setValue(el: any, value: string): Promise<void> {
	await el.updateComplete;
	const t = textarea(el);
	t.value = value;
	t.setSelectionRange(value.length, value.length);
	t.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	await el.updateComplete;
}
async function pressEnter(el: any): Promise<void> {
	await el.updateComplete;
	const t = textarea(el);
	t.focus();
	t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	await new Promise((r) => setTimeout(r, 30));
	await el.updateComplete;
}
async function typeText(el: any, text: string): Promise<void> {
	await el.updateComplete;
	const t = textarea(el);
	t.focus();
	for (const ch of text) {
		t.value += ch;
		t.setSelectionRange(t.value.length, t.value.length);
		t.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		await el.updateComplete;
	}
}
const isSlashMenuOpen = (el: any): boolean => !!el.querySelector(".slash-menu");

beforeEach(() => {
	slashSkills = [];
	sendCalls = [];
	messageSendEvents = [];
	callRouteCalls = [];
	vi.stubGlobal("fetch", async (input: any): Promise<Response> => {
		const url = typeof input === "string" ? input : input?.url || String(input);
		if (url.includes("/api/slash-skills")) {
			return new Response(JSON.stringify({ skills: slashSkills }), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
	});
	launcherFeedbackEvents = [];
	feedbackListener = (event: Event) => {
		const detail = (event as CustomEvent).detail || {};
		launcherFeedbackEvents.push({ kind: detail.kind, message: detail.message });
	};
	window.addEventListener("bobbit-launcher-feedback", feedbackListener);
});
afterEach(() => {
	window.removeEventListener("bobbit-launcher-feedback", feedbackListener);
	document.body.innerHTML = "";
	// Clear the globally-registered composer-slash entrypoints so a later file's
	// MessageEditor doesn't inherit the pr-walkthrough launcher (isolate:false).
	registerPackEntrypoints([] as any);
	vi.unstubAllGlobals();
});

describe("MessageEditor pack composer slash dispatch", () => {
	it("typed /pr-walkthrough <github-pr-url> launches the PR walkthrough route and does not call onSend", async () => {
		const el = mount();
		const prUrl = "https://github.com/SuuBro/bobbit/pull/764";
		await setValue(el, `/pr-walkthrough ${prUrl}`);
		await pressEnter(el);

		expect(sendCalls).toHaveLength(0);
		expect(callRouteCalls).toHaveLength(1);
		expect(callRouteCalls[0]).toMatchObject({
			route: "run",
			packId: "pr-walkthrough",
			contributionId: "pr-walkthrough",
			body: { prUrl },
		});
		expect(messageSendEvents).toHaveLength(1);
		// Item 1: pending message is derived from the launcher label ("PR Walkthrough").
		expect(launcherFeedbackEvents).toContainEqual({ kind: "pending", message: "Starting PR Walkthrough…" });
		// Item 2: a successful launch emits a `resolved` event that clears the pending state.
		expect(launcherFeedbackEvents).toContainEqual({ kind: "resolved", message: "" });
	});

	it("typed /pr-walkthrough <pr-number> launches the PR walkthrough route and does not call onSend", async () => {
		const el = mount();
		await setValue(el, "/pr-walkthrough 764");
		await pressEnter(el);

		expect(sendCalls).toHaveLength(0);
		expect(callRouteCalls).toHaveLength(1);
		expect(callRouteCalls[0]).toMatchObject({
			route: "run",
			packId: "pr-walkthrough",
			contributionId: "pr-walkthrough",
			body: { prNumber: 764 },
		});
		expect(messageSendEvents).toHaveLength(1);
	});

	it("selecting /pr-walkthrough from autocomplete completes the command without launching", async () => {
		const el = mount();
		await typeText(el, "/pr-walkthro");
		expect(isSlashMenuOpen(el)).toBe(true);
		await pressEnter(el);

		expect(el.value).toBe("/pr-walkthrough ");
		expect(sendCalls).toHaveLength(0);
		expect(callRouteCalls).toHaveLength(0);
		expect(messageSendEvents).toHaveLength(0);
	});

	it("selected /pr-walkthrough command launches after the user adds an argument and sends", async () => {
		const el = mount();
		await typeText(el, "/pr-walkthro");
		expect(isSlashMenuOpen(el)).toBe(true);
		await pressEnter(el);
		await typeText(el, "764");
		await pressEnter(el);

		expect(sendCalls).toHaveLength(0);
		expect(callRouteCalls).toHaveLength(1);
		expect(callRouteCalls[0]).toMatchObject({ route: "run", body: { prNumber: 764 } });
		expect(messageSendEvents).toHaveLength(1);
	});

	it("uses the one registered compound launcher key and never falls back to onSend", async () => {
		installLaunchers([{
			id: "open", packId: "pack-one", kind: "composer-slash", label: "Open one",
			target: { action: "spawn", route: "run", panelId: "one.panel" },
		}]);
		const el = document.createElement("message-editor") as any;
		el.sessionId = "pack-slash-session";
		el.cwd = "/tmp";
		el.showAttachmentButton = false;
		el.showModelSelector = false;
		el.showThinkingSelector = false;
		el.onSend = (text: string) => sendCalls.push({ text, attachmentCount: 0 });
		document.body.appendChild(el);
		await setValue(el, "/open argument");
		await pressEnter(el);
		expect(callRouteCalls).toEqual([expect.objectContaining({ packId: "pack-one", contributionId: "open", body: { input: "argument" } })]);
		expect(sendCalls).toEqual([]);
	});

	it("refuses ambiguous same-id launchers in both menu and send dispatch", async () => {
		installLaunchers([
			{ id: "duplicate", packId: "pack-one", kind: "composer-slash", label: "One", target: { action: "spawn", route: "run", panelId: "one.panel" } },
			{ id: "duplicate", packId: "pack-two", kind: "composer-slash", label: "Two", target: { action: "spawn", route: "run", panelId: "two.panel" } },
		]);
		const el = document.createElement("message-editor") as any;
		el.sessionId = "pack-slash-session";
		el.cwd = "/tmp";
		el.showAttachmentButton = false;
		el.showModelSelector = false;
		el.showThinkingSelector = false;
		el.onSend = (text: string) => sendCalls.push({ text, attachmentCount: 0 });
		document.body.appendChild(el);
		await setValue(el, "/duplicate");
		expect(el._slashFilteredSkills.map((item: any) => item.name)).not.toContain("duplicate");
		await pressEnter(el);
		expect(callRouteCalls).toEqual([]);
		expect(sendCalls).toEqual([{ text: "/duplicate", attachmentCount: 0 }]);
	});

	it("a visible Bobbit skill masks a same-name pack launcher in autocomplete and send", async () => {
		slashSkills = [{ name: "review", description: "Bobbit review", source: "project", userInvocable: true }];
		installLaunchers([{
			id: "review", packId: "pack-review", kind: "composer-slash", label: "Pack review",
			target: { action: "spawn", route: "run", panelId: "review.panel" },
		}]);
		const el = mount(false);
		await el.updateComplete;
		await el._loadSlashSkills();
		await setValue(el, "/review");
		expect(el._slashFilteredSkills.map((item: any) => item.name)).toEqual(["review"]);
		expect(el._slashFilteredSkills[0].source).not.toBe("pack");
		// A trailing space closes completion, so Enter exercises full-line dispatch.
		await setValue(el, "/review ");
		await pressEnter(el);
		expect(callRouteCalls).toEqual([]);
		expect(sendCalls).toEqual([{ text: "/review ", attachmentCount: 0 }]);
	});

	it("a menu-hidden server skill still masks a same-name launcher at send time", async () => {
		slashSkills = [{ name: "hidden", description: "Not invocable", source: "project", userInvocable: false }];
		installLaunchers([{
			id: "hidden", packId: "pack-hidden", kind: "composer-slash", label: "Hidden pack",
			target: { action: "spawn", route: "run", panelId: "hidden.panel" },
		}]);
		const el = mount(false);
		await el.updateComplete;
		await el._loadSlashSkills();
		await setValue(el, "/hidden");
		expect(el._slashFilteredSkills.map((item: any) => item.name)).not.toContain("hidden");
		await pressEnter(el);
		expect(callRouteCalls).toEqual([]);
		expect(sendCalls).toEqual([{ text: "/hidden", attachmentCount: 0 }]);
	});

	it("attachments and near-prefixes remain ordinary prompts instead of launcher dispatches", async () => {
		const el = mount();
		el.attachments = [{ id: "a1", type: "image", fileName: "keep.png", mimeType: "image/png", content: "AAAA", preview: "AAAA" }];
		await setValue(el, "/pr-walkthrough 764");
		await pressEnter(el);
		expect(callRouteCalls).toEqual([]);
		expect(sendCalls).toEqual([{ text: "/pr-walkthrough 764", attachmentCount: 1 }]);

		el.attachments = [];
		await setValue(el, "/pr-walkthrough-notes");
		await pressEnter(el);
		expect(callRouteCalls).toEqual([]);
		expect(sendCalls).toEqual([
			{ text: "/pr-walkthrough 764", attachmentCount: 1 },
			{ text: "/pr-walkthrough-notes", attachmentCount: 0 },
		]);
	});
});
