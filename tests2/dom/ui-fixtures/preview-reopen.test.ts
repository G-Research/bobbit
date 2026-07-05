import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/preview-reopen.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled the preview-renderer file:// fixture and drove
// the REAL PreviewOpenRenderer's reopen flow. This port renders the same real
// renderer under happy-dom against app state + a mocked fetch, and mounts a real
// <tool-message> for the lazy-registry placeholder test (same harness as
// preview-renderer.test.ts / lazy-renderer-placeholder.test.ts). "Page reload" is
// ported to re-rendering the same snapshot into a fresh container (history replay).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let PreviewOpenRenderer: typeof import("../../../src/ui/tools/renderers/PreviewRenderer.js").PreviewOpenRenderer;
let render: typeof import("lit").render;
let html: typeof import("lit").html;
let state: any;

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const MARKER = "__preview_snapshot_v1__\n";
const MARKER_V3 = "__preview_snapshot_v3__\n";

let fetchCalls: Array<{ url: string; method: string; body: any }>;
let responder: ((url: string, init: any, idx: number) => { status: number; body: any }) | undefined;

function installFetchMock() {
	vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
		const idx = fetchCalls.length;
		fetchCalls.push({ url: String(url), method: init?.method || "GET", body: init?.body });
		if (String(url).includes("/side-panel-workspace")) {
			return new Response(JSON.stringify({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" }), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		const resp = responder ? responder(String(url), init, idx) : { status: 200, body: { ok: true } };
		return new Response(JSON.stringify(resp.body), { status: resp.status, headers: { "Content-Type": "application/json" } });
	});
}

function makeResultWithSnapshot(htmlStr: string, toolCallId: string) {
	return {
		role: "toolResult", toolCallId, toolName: "preview_open", isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
			{ type: "text", text: MARKER + htmlStr },
		],
		timestamp: Date.now(),
	};
}

function renderPreview(container: HTMLElement, params: any, result: any, isStreaming: boolean, ctx: { sessionId: string; toolUseId: string }) {
	const out = new PreviewOpenRenderer().render(params, result, isStreaming, ctx as any);
	render(out.content, container);
}

function slot(id: string): HTMLElement {
	let el = document.getElementById(id);
	if (!el) { el = document.createElement("div"); el.id = id; document.body.appendChild(el); }
	return el;
}
function freshContainer(): HTMLElement {
	document.getElementById("container")?.remove();
	const el = document.createElement("div");
	el.id = "container";
	document.body.appendChild(el);
	return el;
}

const openBtn = (root: ParentNode = document) => root.querySelector("[data-preview-open-btn]") as HTMLButtonElement;

async function waitForText(getBtn: () => HTMLButtonElement, re: RegExp, timeout = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (re.test(getBtn()?.textContent || "")) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error(`timeout waiting for button text ${re} — got "${getBtn()?.textContent}"`);
}

async function waitForEnabled(getBtn: () => HTMLButtonElement, timeout = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (getBtn() && !getBtn().disabled) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error("timeout waiting for button to re-enable");
}

async function waitForPreviewPost(timeout = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (fetchCalls.some((c) => c.method === "POST" && c.url.includes("/api/preview"))) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error(`timeout waiting for POST /api/preview — got ${JSON.stringify(fetchCalls.map((c) => `${c.method} ${c.url}`))}`);
}

function getPreviewState() {
	return {
		previewPanelEntry: state.previewPanelEntry,
		previewPanelMtime: state.previewPanelMtime,
		previewPanelContentHash: state.previewPanelContentHash,
		previewPanelMountedTabId: state.previewPanelMountedTabId,
		panelTabsBySession: state.panelTabsBySession,
		activePanelTabId: state.activePanelTabId,
		panelWorkspaceActiveBySession: state.panelWorkspaceActiveBySession,
	};
}
function resetPreviewState() {
	state.previewPanelEntry = "";
	state.previewPanelMtime = 0;
	state.previewPanelContentHash = "";
	state.previewPanelMountedTabId = "";
	state.panelTabsBySession = {};
	state.previewVersionsBySession = {};
	state.panelTabs = [];
	state.activePanelTabId = "chat";
	state.panelWorkspaceActiveBySession = {};
	state.sidePanelWorkspaceBySession = {};
	state.lastWorkspaceRevisionBySession = {};
}

beforeAll(async () => {
	(window as any).happyDOM?.setURL?.("file:///test.html");
	localStorage.setItem("gateway.url", "http://localhost");
	await import("../../../src/app/session-manager.js");
	await import("../../../src/ui/components/Messages.js");
	await import("../../../src/ui/tools/index.js"); // registers preview_open lazy renderer
	({ PreviewOpenRenderer } = await import("../../../src/ui/tools/renderers/PreviewRenderer.js"));
	({ render, html } = await import("lit"));
	({ state } = await import("../../../src/app/state.js"));
	__syncCE();
	await customElements.whenDefined("tool-message");
});

beforeEach(() => {
	fetchCalls = [];
	responder = undefined;
	installFetchMock();
	resetPreviewState();
	(state as any).remoteAgent = null;
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Reopenable preview widgets (v2-dom)", () => {
	it("two-preview-swap: click Open on each widget sends correct HTML", async () => {
		document.body.innerHTML = '<div id="slot-a"></div><div id="slot-b"></div>';
		const htmlA = "<!DOCTYPE html><body><h1>Preview A</h1></body>";
		const htmlB = "<!DOCTYPE html><body><h1>Preview B</h1></body>";

		renderPreview(slot("slot-a"), { html: htmlA }, makeResultWithSnapshot(htmlA, "tool-A"), false, { sessionId: SESSION_ID, toolUseId: "tool-A" });
		renderPreview(slot("slot-b"), { html: htmlB }, makeResultWithSnapshot(htmlB, "tool-B"), false, { sessionId: SESSION_ID, toolUseId: "tool-B" });
		fetchCalls = [];

		expect(slot("slot-a").querySelectorAll("[data-preview-open-btn]").length).toBe(1);
		expect(slot("slot-b").querySelectorAll("[data-preview-open-btn]").length).toBe(1);

		openBtn(slot("slot-a")).click();
		await waitForPreviewPost();
		let postsA = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/api/preview"));
		expect(postsA.length).toBe(1);
		expect(JSON.parse(postsA[0].body).html).toBe(htmlA);

		fetchCalls = [];
		openBtn(slot("slot-b")).click();
		await waitForPreviewPost();
		const postsB = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/api/preview"));
		expect(postsB.length).toBe(1);
		expect(JSON.parse(postsB[0].body).html).toBe(htmlB);

		fetchCalls = [];
		await waitForEnabled(() => openBtn(slot("slot-a")));
		openBtn(slot("slot-a")).click();
		await waitForPreviewPost();
		const postsA2 = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/api/preview"));
		expect(postsA2.length).toBe(1);
		expect(JSON.parse(postsA2[0].body).html).toBe(htmlA);
	});

	it("two-preview-swap: state persists across re-render (history replay)", async () => {
		const htmlA = "<!DOCTYPE html><body>A-after-reload</body>";
		const mkResult = () => ({
			role: "toolResult", toolCallId: "tool-A", toolName: "preview_open", isError: false,
			content: [
				{ type: "text", text: "Preview panel is open and will auto-update." },
				{ type: "text", text: MARKER + htmlA },
			],
			timestamp: Date.now(),
		});

		renderPreview(freshContainer(), { html: htmlA }, mkResult(), false, { sessionId: SESSION_ID, toolUseId: "tool-A" });
		expect(openBtn().disabled).toBe(false);

		// Simulate reload + history replay: re-render the same snapshot into a fresh container.
		resetPreviewState();
		renderPreview(freshContainer(), { html: htmlA }, mkResult(), false, { sessionId: SESSION_ID, toolUseId: "tool-A" });
		fetchCalls = [];

		openBtn().click();
		await waitForText(() => openBtn(), /Opened/);
		const post = fetchCalls.find((c) => c.method === "POST" && c.url.includes("/api/preview"));
		expect(post).toBeTruthy();
		expect(JSON.parse(post!.body).html).toBe(htmlA);
	});

	it("v3 reopen imperatively refreshes preview panel state (stale-panel fix)", async () => {
		const sid = "22222222-2222-2222-2222-222222222222";
		const entryA = "index-A.html";
		const entryB = "index-B.html";
		const entryC = "index-C.html";
		const fileB = "/tmp/preview/index-B.html";
		const htmlA = "<p>A restored inline payload</p>";
		const snapA = MARKER_V3 + JSON.stringify({ kind: "preview", url: `/preview/${sid}/${entryA}`, path: `/state/preview/${sid}/${entryA}`, entry: entryA });
		const snapB = MARKER_V3 + JSON.stringify({ kind: "preview", url: `/preview/${sid}/${entryB}`, path: `/state/preview/${sid}/${entryB}`, entry: entryB });
		const snapC = MARKER_V3 + JSON.stringify({ kind: "preview", url: `/preview/${sid}/${entryC}`, path: `/state/preview/${sid}/${entryC}`, entry: entryC });

		document.body.innerHTML = '<div id="slot-a"></div><div id="slot-b"></div><div id="slot-c"></div>';
		const result = (toolCallId: string, snapshot: string) => ({
			role: "toolResult", toolCallId, toolName: "preview_open", isError: false,
			content: [
				{ type: "text", text: "Preview panel is open and will auto-update." },
				{ type: "text", text: snapshot },
			],
			timestamp: Date.now(),
		});
		renderPreview(slot("slot-a"), { html: htmlA }, result("tool-A", snapA), false, { sessionId: sid, toolUseId: "tool-A" });
		renderPreview(slot("slot-b"), { file: fileB }, result("tool-B", snapB), false, { sessionId: sid, toolUseId: "tool-B" });
		renderPreview(slot("slot-c"), undefined, result("tool-C", snapC), false, { sessionId: sid, toolUseId: "tool-C" });

		responder = (url, init) => {
			if (init?.method === "POST" && url.includes("/api/preview/mount")) {
				const body = JSON.parse(init.body || "{}");
				if (body.file) return { status: 200, body: { ok: true, entry: entryB, mtime: 20 } };
				if (body.html) return { status: 200, body: { ok: true, entry: entryA, mtime: 30 } };
			}
			return { status: 200, body: { ok: true } };
		};
		resetPreviewState();
		fetchCalls = [];

		// Simulate the user already having previewed B (panel currently shows B).
		openBtn(slot("slot-b")).click();
		await waitForText(() => openBtn(slot("slot-b")), /Opened/);
		let st = getPreviewState();
		expect(st.previewPanelEntry).toBe(entryB);
		expect(st.previewPanelMtime).toBe(20);
		let posts = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/api/preview/mount"));
		expect(posts.length).toBe(1);
		expect(JSON.parse(posts[0].body)).toEqual({ file: fileB });

		// Now click Open on the FIRST card (A). Bug repro: panel state stays at B.
		fetchCalls = [];
		openBtn(slot("slot-a")).click();
		await waitForText(() => openBtn(slot("slot-a")), /Opened/);
		st = getPreviewState();
		expect(st.previewPanelEntry).toBe(entryA);
		expect(st.previewPanelMtime).toBe(30);
		posts = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/api/preview/mount"));
		expect(posts.length).toBe(1);
		expect(JSON.parse(posts[0].body)).toEqual({ html: htmlA });
		const patchA = fetchCalls.filter((c) => c.method === "PATCH" && c.url.includes("/api/sessions/"));
		expect(patchA.length).toBeGreaterThanOrEqual(1);

		// A v3 card without restorable inline/file params still refreshes stale panel
		// state from the snapshot entry, but does not POST a new mount.
		fetchCalls = [];
		openBtn(slot("slot-c")).click();
		await waitForText(() => openBtn(slot("slot-c")), /Opened/);
		st = getPreviewState();
		expect(st.previewPanelEntry).toBe(entryC);
		expect(st.previewPanelMtime).toBeGreaterThan(30);
		posts = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/api/preview/mount"));
		expect(posts.length).toBe(0);
	});

	it("placeholder is stable while preview_open chunk loads (lazy registry)", async () => {
		const htmlA = "<!DOCTYPE html><body>placeholder-test</body>";
		const result = makeResultWithSnapshot(htmlA, "tool-A");
		const container = freshContainer();
		const toolCall = { id: "tool-A", name: "preview_open", arguments: { html: htmlA } };
		render(
			html`<tool-message
				.toolCall=${toolCall}
				.tool=${{ name: "preview_open" }}
				.result=${result}
				.pending=${false}
				.aborted=${false}
				.isStreaming=${false}
			></tool-message>`,
			container,
		);
		const tm = container.querySelector("tool-message") as any;
		if (tm?.updateComplete) await tm.updateComplete;

		// Card wrapper present from t=0.
		expect(document.querySelectorAll("tool-message .border.rounded-md").length).toBe(1);

		// The Open button materialises inside the SAME card within 2s.
		const start = Date.now();
		while (Date.now() - start < 2000) {
			if (document.querySelector('tool-message .border.rounded-md [data-testid="preview-open-button"]')) break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(document.querySelector('tool-message .border.rounded-md [data-testid="preview-open-button"]')).toBeTruthy();
		expect(document.querySelectorAll("tool-message .border.rounded-md").length).toBe(1);
	});

	it("archived fallback: legacy single-block preview_open renders disabled button", async () => {
		const legacyResult = {
			role: "toolResult", toolCallId: "tool-legacy", toolName: "preview_open", isError: false,
			content: [{ type: "text", text: "Preview panel is open and will auto-update." }],
			timestamp: Date.now(),
		};
		renderPreview(freshContainer(), { html: "<p>legacy</p>" }, legacyResult, false, { sessionId: SESSION_ID, toolUseId: "tool-legacy" });

		const b = openBtn();
		expect(b.disabled).toBe(true);
		expect(b.getAttribute("title")).toMatch(/Snapshot not captured/);

		fetchCalls = [];
		b.click();
		expect(fetchCalls.length).toBe(0);
	});
});
