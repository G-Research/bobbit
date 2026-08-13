import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/preview-renderer.spec.ts (v2-dom tier).
// The legacy spec esbuild-bundled a file:// entry that rendered the REAL
// PreviewOpenRenderer and drove its reopen flow (PATCH/POST/artifact-restore)
// against app state + a mocked fetch. This port imports the SAME real modules and
// replicates the entry's window helpers as module functions. side-panel-workspace
// keys its in-memory (non-server) tab path off `window.location.protocol ===
// "file:"`, so the happy-dom URL is set to file:// in beforeAll — exactly what the
// legacy file:// fixture provided.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetGatewayConnectionForTests,
	commitGatewayConnection,
} from "../../src/app/gateway-fetch.js";

let PreviewOpenRenderer: typeof import("../../src/ui/tools/renderers/PreviewRenderer.js").PreviewOpenRenderer;
let render: typeof import("lit").render;
let state: any;
let previewEntryTabId: typeof import("../../src/app/panel-workspace.js").previewEntryTabId;
let registerPreviewVersion: typeof import("../../src/app/panel-workspace.js").registerPreviewVersion;

const MARKER = "__preview_snapshot_v1__\n";
const MARKER_V2 = "__preview_snapshot_v2__\n";
const MARKER_V3 = "__preview_snapshot_v3__\n";
const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const HASH = "b".repeat(64);
const TOOL_USE_ID = "tool-1";
const INLINE_TAB_ID = "preview:entry:inline.html";
const ARTIFACT_ID = "artifact-inline";

// ── fetch mock (ported from preview-renderer-entry.ts) ──────────────────────
let fetchCalls: Array<{ url: string; method: string; body: any }>;
let responder: ((url: string, init: any, idx: number) => { status: number; body: any }) | undefined;

function installFetchMock() {
	vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
		const idx = fetchCalls.length;
		fetchCalls.push({ url: String(url), method: init?.method || "GET", body: init?.body });
		if (String(url).includes("/side-panel-workspace")) {
			// Valid workspace body so the fire-and-forget settleMutation resolves
			// instead of throwing "Invalid side-panel workspace response" as a
			// run-failing unhandled rejection when the mutation settles post-test.
			return new Response(JSON.stringify({ version: 1, tabs: [], activeTabId: "", sizeMode: "split" }), { status: 200, headers: { "Content-Type": "application/json" } });
		}
		const resp = responder ? responder(String(url), init, idx) : { status: 200, body: { ok: true } };
		return new Response(JSON.stringify(resp.body), { status: resp.status, headers: { "Content-Type": "application/json" } });
	});
}

// ── result factories (identical to the legacy spec) ─────────────────────────
function makeResultWithSnapshot(html: string) {
	return { role: "toolResult", toolCallId: TOOL_USE_ID, toolName: "preview_open", isError: false, content: [
		{ type: "text", text: "Preview panel is open and will auto-update." },
		{ type: "text", text: MARKER + html },
	], timestamp: Date.now() };
}
function makePreviewResult(entry: string, contentHash?: string, artifactId?: string) {
	const snapshot: Record<string, string> = { kind: "preview", url: `/preview/${SESSION_ID}/${entry}`, path: `${SESSION_ID}/${entry}` };
	if (contentHash) snapshot.contentHash = contentHash;
	if (artifactId) snapshot.artifactId = artifactId;
	return makePreviewResultFromPayload(snapshot);
}
function makePreviewResultFromPayload(snapshot: Record<string, unknown>) {
	return { role: "toolResult", toolCallId: TOOL_USE_ID, toolName: "preview_open", isError: false, content: [
		{ type: "text", text: "Preview panel is open and will auto-update." },
		{ type: "text", text: MARKER_V3 + JSON.stringify(snapshot) + "\n" },
	], timestamp: Date.now() };
}
const makePreviewResultWithSnapshot = (entry = "inline.html", contentHash = HASH, artifactId = ARTIFACT_ID) => makePreviewResult(entry, contentHash, artifactId);
const makePreviewResultWithoutArtifact = (entry = "inline.html", contentHash = HASH) => makePreviewResult(entry, contentHash, undefined);
function makeFileResultWithSnapshot(filePath: string) {
	return { role: "toolResult", toolCallId: TOOL_USE_ID, toolName: "preview_open", isError: false, content: [
		{ type: "text", text: "Preview panel is open and will auto-update." },
		{ type: "text", text: MARKER_V2 + JSON.stringify({ kind: "file", path: filePath }) + "\n" },
	], timestamp: Date.now() };
}
function makeLegacyResult() {
	return { role: "toolResult", toolCallId: TOOL_USE_ID, toolName: "preview_open", isError: false, content: [
		{ type: "text", text: "Preview panel is open and will auto-update." },
	], timestamp: Date.now() };
}
function makeErrorResult() {
	return { role: "toolResult", toolCallId: TOOL_USE_ID, toolName: "preview_open", isError: true, content: [{ type: "text", text: "Error reading file." }], timestamp: Date.now() };
}
function makeTruncatedResult(originalLength: number) {
	return { role: "toolResult", toolCallId: TOOL_USE_ID, toolName: "preview_open", isError: false, content: [
		{ type: "text", text: "Preview panel is open and will auto-update." },
		{ type: "text", text: MARKER, _truncated: true, _originalLength: originalLength, preview: "<p>truncated preview</p>" },
	], timestamp: Date.now() };
}

// ── ported window helpers ───────────────────────────────────────────────────
function renderPreview(container: HTMLElement, params: any, result: any = undefined, isStreaming = false) {
	const out = new PreviewOpenRenderer().render(params, result, isStreaming, { sessionId: SESSION_ID, toolUseId: TOOL_USE_ID } as any);
	render(out.content, container);
}
function setMessages(messages: any[]) { (state as any).remoteAgent = { state: { messages } }; }
function setPreviewWorkspace(sessionId: string, hash: string, entry = "inline.html", previousHashes: string[] = []) {
	const tabId = previewEntryTabId(entry);
	for (const previousHash of previousHashes) registerPreviewVersion(state, sessionId, entry, previousHash, { current: false });
	const version = registerPreviewVersion(state, sessionId, entry, hash, { current: true });
	state.previewPanelEntry = entry;
	state.previewPanelMtime = 123;
	state.previewPanelContentHash = hash;
	state.isPreviewSession = true;
	state.panelTabsBySession = {
		[sessionId]: [{
			id: tabId, kind: "preview", title: entry, label: entry, legacyTab: "preview",
			source: { type: "preview", entry, sessionId, live: true, contentHash: hash, version },
			state: { entry, contentHash: hash, version },
		}],
	};
	state.panelTabs = state.panelTabsBySession[sessionId];
	state.panelWorkspaceActiveBySession = { [sessionId]: tabId };
	state.activePanelTabId = tabId;
	state.previewPanelMountedTabId = tabId;
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
	// Cross-file isolation: this file runs under pool:forks + isolate:false in the
	// v2-dom lane, so the `state` singleton (and its non-preview panel inputs) are
	// SHARED with sibling dom test files. When sidePanelWorkspaceBySession[sid] is
	// empty (as it is after this reset), the file:// fixture path rebuilds the base
	// workspace via buildPanelWorkspaceTabs, which derives a `proposal:<type>` /
	// review / inbox tab from these fields. A prior file that leaves e.g.
	// `activeProposals.goal` set (its afterEach doesn't clear the singleton) would
	// otherwise bleed a phantom `proposal:goal` tab into every preview assertion
	// here. Reset the full set of derived-tab inputs so the preview flow only ever
	// sees the tabs this file creates. (Product behaviour — deriving a proposal tab
	// from activeProposals — is intentional and deliberately NOT changed.)
	state.isPreviewSession = false;
	state.activeProposals = {};
	state.assistantType = null;
	state.assistantHasProposal = false;
	state.reviewPanelOpen = false;
	state.reviewDocuments = new Map();
	state.inboxPanelOpen = false;
	state.inboxEntries = [];
}

function container(): HTMLElement {
	// Always a FRESH node: lit caches a ChildPart per container, so clearing
	// innerHTML on a reused node (the legacy v1/v2 loop) would strand lit's part
	// on removed nodes and crash the next render. A new element renders clean.
	document.getElementById("container")?.remove();
	const el = document.createElement("div");
	el.id = "container";
	document.body.appendChild(el);
	return el;
}
const btn = () => document.querySelector("[data-preview-open-btn]") as HTMLButtonElement;
async function waitForText(re: RegExp, timeout = 3000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (re.test(btn()?.textContent || "")) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error(`timeout waiting for button text ${re} — got "${btn()?.textContent}"`);
}
async function waitForAssertion(assertion: () => void, timeout = 3000): Promise<void> {
	const start = Date.now();
	let lastError: unknown;
	while (Date.now() - start < timeout) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 15));
		}
	}
	throw lastError;
}

beforeAll(async () => {
	(window as any).happyDOM?.setURL?.("file:///test.html");
	await import("../../src/app/session-manager.js");
	await import("../../src/ui/components/Messages.js");
	({ PreviewOpenRenderer } = await import("../../src/ui/tools/renderers/PreviewRenderer.js"));
	({ render } = await import("lit"));
	({ state } = await import("../../src/app/state.js"));
	({ previewEntryTabId, registerPreviewVersion } = await import("../../src/app/panel-workspace.js"));
	__syncCE();
});

beforeEach(() => {
	localStorage.clear();
	__resetGatewayConnectionForTests();
	commitGatewayConnection("http://localhost/team/bobbit", "test-token");
	fetchCalls = [];
	responder = undefined;
	installFetchMock();
	resetPreviewState();
	(state as any).remoteAgent = null;
});

afterEach(() => {
	__resetGatewayConnectionForTests();
	localStorage.clear();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("PreviewOpenRenderer", () => {
	it("renders enabled Open button for completed preview with inline snapshot", () => {
		renderPreview(container(), { html: "<p>hi</p>" }, makeResultWithSnapshot("<p>hi</p>"), false);
		const b = btn();
		expect(b).toBeTruthy();
		expect(b.disabled).toBe(false);
		expect(b.textContent?.trim()).toBe("Open");
	});

	it("renders disabled Open button for legacy single-block result", () => {
		renderPreview(container(), { html: "<p>legacy</p>" }, makeLegacyResult(), false);
		const b = btn();
		expect(b.disabled).toBe(true);
		expect(b.getAttribute("title")).toMatch(/Snapshot not captured/);
	});

	it("renders disabled Open button while streaming", () => {
		renderPreview(container(), { html: "<p>streaming</p>" }, undefined, true);
		const b = btn();
		expect(b.disabled).toBe(true);
		expect(b.getAttribute("title")).toMatch(/Waiting/);
	});

	it("renders disabled Open button for error result", () => {
		renderPreview(container(), { html: "<p>x</p>" }, makeErrorResult(), false);
		expect(btn().disabled).toBe(true);
	});

	it("click with inline snapshot: PATCH then POST /api/preview with marker-stripped HTML", async () => {
		const html = "<p>hello-world</p>";
		renderPreview(container(), { html }, makeResultWithSnapshot(html), false);
		responder = (url, init) => {
			if (init?.method === "POST" && url.includes("/api/preview/mount")) return { status: 200, body: { entry: "inline.html", mtime: 234, contentHash: HASH } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/Opened/);

		expect(fetchCalls.length).toBe(2);
		expect(fetchCalls[0].method).toBe("PATCH");
		expect(fetchCalls[0].url).toContain(`/api/sessions/${SESSION_ID}`);
		expect(JSON.parse(fetchCalls[0].body)).toEqual({ preview: true });
		expect(fetchCalls[1].method).toBe("POST");
		expect(fetchCalls[1].url).toContain(`/api/preview/mount?sessionId=${SESSION_ID}`);
		const postBody = JSON.parse(fetchCalls[1].body);
		expect(postBody.html).toBe(html);
		expect(postBody.html).not.toContain("__preview_snapshot_v1__");

		const ps = getPreviewState();
		const tabs = ps.panelTabsBySession[SESSION_ID];
		expect(tabs.map((t: any) => t.id)).toEqual([INLINE_TAB_ID]);
		expect(tabs[0].state.contentHash).toBe(HASH);
		expect(tabs[0].label).toBe("inline.html");
		expect(ps.panelWorkspaceActiveBySession[SESSION_ID]).toBe(INLINE_TAB_ID);
	});

	it("click with truncated snapshot: GET tool-content then PATCH then POST", async () => {
		const fullHtml = "<p>" + "x".repeat(40000) + "</p>";
		const result = makeTruncatedResult(MARKER.length + fullHtml.length);
		setMessages([result]);
		responder = (url, init) => {
			if (url.includes("/tool-content/") && (!init || init.method === "GET" || !init.method)) return { status: 200, body: { content: MARKER + fullHtml } };
			return { status: 200, body: { ok: true } };
		};
		renderPreview(container(), { html: "<p>x</p>" }, result, false);
		fetchCalls = [];

		btn().click();
		await waitForText(/Opened/);

		expect(fetchCalls.length).toBe(3);
		expect(fetchCalls[0].method).toBe("GET");
		expect(fetchCalls[0].url).toContain(`/tool-content/by-tool-call/${TOOL_USE_ID}/1?expected=preview-snapshot`);
		expect(fetchCalls[1].method).toBe("PATCH");
		expect(fetchCalls[2].method).toBe("POST");
		const postBody = JSON.parse(fetchCalls[2].body);
		expect(postBody.html).toBe(fullHtml);
		expect(postBody.html).not.toContain("__preview_snapshot_v1__");
	});

	it("reopens a truncated snapshot after a client-only compaction placeholder shifts its index", async () => {
		const html = "<p>reopened after compaction</p>";
		const fullSnapshot = MARKER_V3 + JSON.stringify({
			kind: "preview",
			url: `/preview/${SESSION_ID}/inline.html`,
			path: `${SESSION_ID}/inline.html`,
			contentHash: HASH,
		}) + " ".repeat(32_768);
		const result = {
			role: "toolResult", toolCallId: TOOL_USE_ID, toolName: "preview_open", isError: false,
			content: [
				{ type: "text", text: "Preview panel is open and will auto-update." },
				{ type: "text", text: MARKER_V3, _truncated: true, _originalLength: fullSnapshot.length, preview: fullSnapshot.slice(0, 512) },
			],
			timestamp: Date.now(),
		};
		const clientOnlyCompactionPlaceholder = {
			role: "assistant",
			content: [{ type: "text", text: "Compacting earlier transcript…" }],
			timestamp: Date.now(),
		};
		const runtimeMessages = [
			result,
			{
				role: "toolResult", toolCallId: "unrelated-runtime-call", toolName: "write", isError: false,
				content: [{ type: "text", text: "unrelated status" }, { type: "text", text: "unrelated runtime block" }],
				timestamp: Date.now(),
			},
		];
		// The compaction row is visible only in the client transcript. It shifts this
		// result to index 1, while raw runtime index 1 is an unrelated tool result.
		setMessages([clientOnlyCompactionPlaceholder, result]);
		responder = (url, init) => {
			if (url.includes(`/tool-content/by-tool-call/${TOOL_USE_ID}/1?expected=preview-snapshot`)) {
				return { status: 200, body: { content: fullSnapshot } };
			}
			if (url.includes("/tool-content/")) return { status: 200, body: { content: runtimeMessages[1].content[1].text } };
			if (init?.method === "POST" && url.includes("/api/preview/mount")) {
				return { status: 200, body: { entry: "inline.html", mtime: 345, contentHash: HASH } };
			}
			return { status: 200, body: { ok: true } };
		};
		renderPreview(container(), { html }, result, false);
		fetchCalls = [];

		btn().click();
		await waitForText(/Opened/);

		expect(fetchCalls.map((call) => call.method)).toEqual(["GET", "PATCH", "POST"]);
		expect(fetchCalls[0].url).toContain(`/tool-content/by-tool-call/${TOOL_USE_ID}/1?expected=preview-snapshot`);
		expect(fetchCalls[0].url).not.toMatch(/\/tool-content\/1\/1$/);
		expect(JSON.parse(fetchCalls[2].body)).toEqual({ html });
	});

	it("reports a missing identity block as terminal transcript unavailability", async () => {
		const result = makeTruncatedResult(100);
		responder = (url) => url.includes("/tool-content/")
			? { status: 404, body: { error: "transcript_block_unavailable", code: "transcript_block_unavailable" } }
			: { status: 200, body: { ok: true } };
		renderPreview(container(), { html: "<p>missing</p>" }, result, false);
		fetchCalls = [];

		btn().click();
		await waitForText(/Transcript block unavailable/);

		expect(btn().disabled).toBe(true);
		expect(btn().getAttribute("title")).toMatch(/no longer available/i);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0].url).toContain(`/tool-content/by-tool-call/${TOOL_USE_ID}/1?expected=preview-snapshot`);
	});

	it("reports a missing identity call as terminal transcript unavailability", async () => {
		const result = makeTruncatedResult(100);
		responder = (url) => url.includes("/tool-content/")
			? { status: 404, body: { error: "transcript_tool_call_unavailable", code: "transcript_tool_call_unavailable" } }
			: { status: 200, body: { ok: true } };
		renderPreview(container(), { html: "<p>missing call</p>" }, result, false);

		btn().click();
		await waitForText(/Transcript block unavailable/);

		expect(btn().disabled).toBe(true);
		expect(btn().getAttribute("title")).toMatch(/no longer available/i);
		expect(fetchCalls).toHaveLength(1);
	});

	it("reports a wrong identity block as a malformed snapshot marker", async () => {
		const result = makeTruncatedResult(100);
		responder = (url) => url.includes("/tool-content/")
			? { status: 409, body: { error: "snapshot_block_mismatch", code: "snapshot_block_mismatch" } }
			: { status: 200, body: { ok: true } };
		renderPreview(container(), { html: "<p>wrong</p>" }, result, false);
		fetchCalls = [];

		btn().click();
		await waitForText(/Malformed snapshot marker/);

		expect(btn().disabled).toBe(true);
		expect(btn().getAttribute("title")).toMatch(/not a preview snapshot/i);
		expect(fetchCalls).toHaveLength(1);
	});

	it("reports a generic tool-call mismatch as a malformed snapshot marker", async () => {
		const result = makeTruncatedResult(100);
		responder = (url) => url.includes("/tool-content/")
			? { status: 409, body: { error: "tool_call_block_mismatch", code: "tool_call_block_mismatch" } }
			: { status: 200, body: { ok: true } };
		renderPreview(container(), { html: "<p>wrong generic block</p>" }, result, false);

		btn().click();
		await waitForText(/Malformed snapshot marker/);

		expect(btn().disabled).toBe(true);
		expect(btn().getAttribute("title")).toMatch(/not a preview snapshot/i);
		expect(fetchCalls).toHaveLength(1);
	});

	it("reports an invalid fetched marker as terminal without mounting", async () => {
		const result = makeTruncatedResult(100);
		responder = (url) => url.includes("/tool-content/")
			? { status: 200, body: { content: `${MARKER_V3}{not-json}` } }
			: { status: 200, body: { ok: true } };
		renderPreview(container(), { html: "<p>malformed</p>" }, result, false);
		fetchCalls = [];

		btn().click();
		await waitForText(/Malformed snapshot marker/);

		expect(btn().disabled).toBe(true);
		expect(fetchCalls).toHaveLength(1);
	});

	it("v2 marker: click POSTs {kind:file, path} and shows Opened", async () => {
		const filePath = "/abs/path/to/report.html";
		renderPreview(container(), { file: filePath }, makeFileResultWithSnapshot(filePath), false);
		responder = (url, init) => {
			if (init?.method === "POST" && url.includes("/api/preview/mount")) return { status: 200, body: { entry: "report.html", mtime: 345, contentHash: HASH } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/Opened/);

		expect(fetchCalls.length).toBe(2);
		expect(fetchCalls[0].method).toBe("PATCH");
		expect(fetchCalls[1].method).toBe("POST");
		expect(fetchCalls[1].url).toContain(`/api/preview/mount?sessionId=${SESSION_ID}`);
		const postBody = JSON.parse(fetchCalls[1].body);
		expect(postBody.file).toBe(filePath);
		expect(postBody.html).toBeUndefined();
		expect(postBody.kind).toBeUndefined();

		const ps = getPreviewState();
		const tabs = ps.panelTabsBySession[SESSION_ID];
		expect(tabs.map((t: any) => t.id)).toEqual(["preview:entry:report.html"]);
		expect(tabs[0].state.contentHash).toBe(HASH);
		expect(tabs[0].label).toBe("report.html");
		expect(ps.panelWorkspaceActiveBySession[SESSION_ID]).toBe("preview:entry:report.html");
	});

	it("legacy v1/v2 markers: matching remount hash reuses the filename tab", async () => {
		const filePath = "/abs/path/to/report.html";
		const cases = [
			{ params: { html: "<p>legacy inline</p>" }, result: makeResultWithSnapshot("<p>legacy inline</p>") },
			{ params: { file: filePath }, result: makeFileResultWithSnapshot(filePath) },
		];
		for (const legacy of cases) {
			resetPreviewState();
			setPreviewWorkspace(SESSION_ID, HASH);
			renderPreview(container(), legacy.params, legacy.result, false);
			responder = (url, init) => {
				if (init?.method === "POST" && url.includes("/api/preview/mount")) return { status: 200, body: { entry: "inline.html", mtime: 456, contentHash: HASH } };
				return { status: 200, body: { ok: true } };
			};
			fetchCalls = [];

			btn().click();
			await waitForText(/Opened/);

			expect(fetchCalls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
			const ps = getPreviewState();
			const tabs = ps.panelTabsBySession[SESSION_ID];
			expect(tabs.map((t: any) => t.id)).toEqual([INLINE_TAB_ID]);
			expect(tabs[0].state.contentHash).toBe(HASH);
			expect(tabs[0].label).toBe("inline.html");
			expect(ps.panelWorkspaceActiveBySession[SESSION_ID]).toBe(INLINE_TAB_ID);
		}
	});

	it("v3 marker: identical content reuses the live preview tab without remounting relative files", async () => {
		resetPreviewState();
		setPreviewWorkspace(SESSION_ID, HASH);
		renderPreview(container(), { file: "relative/report.html" }, makePreviewResultWithSnapshot("inline.html", HASH), false);
		responder = (url, init) => {
			if (init?.method === "POST" && url.includes("/api/preview/mount")) return { status: 404, body: { error: "file no longer available" } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		const b = btn();
		expect(b.textContent || "").not.toMatch(/File no longer available/);
		b.click();
		await waitForText(/Opened/);
		expect(b.textContent || "").not.toMatch(/File no longer available/);

		expect(fetchCalls.map((c) => c.method)).toEqual(["PATCH"]);
		expect(fetchCalls.some((c) => c.method === "POST" && String(c.url).includes("/api/preview/mount"))).toBe(false);
		const ps = getPreviewState();
		const tabs = ps.panelTabsBySession[SESSION_ID];
		expect(tabs.map((t: any) => t.id)).toEqual([INLINE_TAB_ID]);
		expect(tabs[0].label).toBe("inline.html");
		expect(tabs[0].state.artifactId).toBe(ARTIFACT_ID);
		expect(tabs[0].state.historical).toBe(false);
		expect(ps.panelWorkspaceActiveBySession[SESSION_ID]).toBe(INLINE_TAB_ID);
		expect(ps.previewPanelContentHash).toBe(HASH);
		expect(ps.previewPanelMountedTabId).toBe(INLINE_TAB_ID);
	});

	it("v3 marker: latest card with prior versions still selects the filename tab", async () => {
		const oldHash = "a".repeat(64);
		resetPreviewState();
		setPreviewWorkspace(SESSION_ID, HASH, "inline.html", [oldHash]);
		renderPreview(container(), { html: "<p>latest</p>" }, makePreviewResultWithSnapshot("inline.html", HASH, ARTIFACT_ID), false);
		responder = (_url, init) => {
			if (init?.method === "POST") return { status: 500, body: { error: "unexpected restore" } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/Opened/);

		expect(fetchCalls.map((c) => c.method)).toEqual(["PATCH"]);
		const ps = getPreviewState();
		const tabs = ps.panelTabsBySession[SESSION_ID];
		expect(tabs.map((t: any) => t.id)).toEqual([INLINE_TAB_ID]);
		expect(tabs[0].label).toBe("inline.html");
		expect(tabs[0].state.version).toBe(2);
		expect(tabs[0].state.historical).toBe(false);
		expect(ps.panelWorkspaceActiveBySession[SESSION_ID]).toBe(INLINE_TAB_ID);
		expect(ps.previewPanelMountedTabId).toBe(INLINE_TAB_ID);
	});

	it("v3 canonical compact marker reopens the historical artifact", async () => {
		const entry = "roadmap.html";
		const oldHash = "c".repeat(64);
		const result = {
			role: "toolResult", toolCallId: TOOL_USE_ID, toolName: "preview_open", isError: false,
			content: [
				{ type: "text", text: "Preview panel is open and will auto-update." },
				{ type: "text", text: MARKER_V3 + JSON.stringify({
					kind: "preview",
					url: `/preview/${SESSION_ID}/`,
					entry,
					contentHash: HASH,
					artifactId: ARTIFACT_ID,
				}) + "\n" },
			],
			timestamp: Date.now(),
		};
		resetPreviewState();
		setPreviewWorkspace(SESSION_ID, oldHash, entry);
		renderPreview(container(), { html: "<p>historical roadmap</p>" }, result, false);
		responder = (url, init) => {
			if (init?.method === "POST" && url.includes(`/api/preview/artifacts/${ARTIFACT_ID}/restore`)) return { status: 200, body: { entry, mtime: 456, contentHash: HASH, artifactId: ARTIFACT_ID, url: `/preview/${SESSION_ID}/${entry}` } };
			if (init?.method === "POST" && url.includes("/api/preview/mount")) return { status: 500, body: { error: "unexpected mount fallback" } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/Opened/);

		expect(fetchCalls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
		expect(fetchCalls[1].url).toContain(`/api/preview/artifacts/${ARTIFACT_ID}/restore?sessionId=${SESSION_ID}`);
		expect(JSON.parse(fetchCalls[1].body)).toEqual({ artifactId: ARTIFACT_ID });
	});

	it("infers a long raw percent/unicode entry from params for an entry-omitted compact marker's sidebar metadata", async () => {
		const entry = `${"résumé-100%-日本語-".repeat(10)}overview.html`;
		const file = `/tmp/preview-input/nested/${entry}`;
		const result = makePreviewResultFromPayload({
			kind: "preview",
			url: `/preview/${SESSION_ID}/`,
			contentHash: HASH,
			artifactId: ARTIFACT_ID,
		});
		state.previewPanelEntry = entry;
		state.previewPanelMtime = 789;
		state.previewPanelContentHash = HASH;
		state.isPreviewSession = true;

		renderPreview(container(), { file }, result, false);

		await waitForAssertion(() => {
			const tabs = state.panelTabsBySession[SESSION_ID];
			expect(tabs).toHaveLength(1);
			expect(tabs[0].label).toBe(entry);
			expect(tabs[0].source.entry).toBe(entry);
			expect(tabs[0].state.entry).toBe(entry);
			expect(tabs[0].state.artifactId).toBe(ARTIFACT_ID);
			expect(tabs[0].state.url).toBe(`/preview/${SESSION_ID}/${encodeURIComponent(entry)}`);
			expect(state.panelWorkspaceActiveBySession[SESSION_ID]).toBe(previewEntryTabId(entry));
		});
	});

	it("reopens an entry-omitted compact marker's aliased artifact using the exact long raw basename", async () => {
		const entry = `${"résumé-100%-日本語-".repeat(10)}restore.html`;
		const file = `/tmp/preview-input/nested/${entry}`;
		const oldHash = "c".repeat(64);
		const result = makePreviewResultFromPayload({
			kind: "preview",
			url: `/preview/${SESSION_ID}/`,
			contentHash: HASH,
			a: ARTIFACT_ID,
		});
		setPreviewWorkspace(SESSION_ID, oldHash, entry);
		renderPreview(container(), { file }, result, false);
		responder = (url, init) => {
			if (init?.method === "POST" && url.includes(`/api/preview/artifacts/${ARTIFACT_ID}/restore`)) {
				return {
					status: 200,
					body: {
						entry,
						mtime: 456,
						contentHash: HASH,
						artifactId: ARTIFACT_ID,
						url: `/preview/${SESSION_ID}/${encodeURIComponent(entry)}`,
					},
				};
			}
			if (init?.method === "POST" && url.includes("/api/preview/mount")) return { status: 500, body: { error: "unexpected mount fallback" } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/Opened/);

		expect(fetchCalls.map((call) => call.method)).toEqual(["PATCH", "POST"]);
		expect(fetchCalls[1].url).toContain(`/api/preview/artifacts/${ARTIFACT_ID}/restore?sessionId=${SESSION_ID}`);
		expect(JSON.parse(fetchCalls[1].body)).toEqual({ artifactId: ARTIFACT_ID });
		const tabs = state.panelTabsBySession[SESSION_ID];
		expect(tabs.map((tab: any) => tab.id)).toEqual([
			previewEntryTabId(entry),
			`${previewEntryTabId(entry)}:v:2`,
		]);
		expect(tabs[1].label).toBe(`${entry} (v2)`);
		expect(tabs[1].source.entry).toBe(entry);
		expect(tabs[1].state.entry).toBe(entry);
		expect(tabs[1].state.artifactId).toBe(ARTIFACT_ID);
		expect(tabs[1].state.url).toBe(`/preview/${SESSION_ID}/${encodeURIComponent(entry)}`);
	});

	it("rejects entry-omitted compact markers without a trusted params entry or both metadata values", async () => {
		const entry = "trusted-100%-日本語.html";
		const cases = [
			{ name: "no associated params", params: {}, snapshot: { kind: "preview", url: `/preview/${SESSION_ID}/`, contentHash: HASH, artifactId: ARTIFACT_ID } },
			{ name: "missing content hash", params: { file: `/tmp/${entry}` }, snapshot: { kind: "preview", url: `/preview/${SESSION_ID}/`, artifactId: ARTIFACT_ID } },
			{ name: "missing artifact id", params: { file: `/tmp/${entry}` }, snapshot: { kind: "preview", url: `/preview/${SESSION_ID}/`, contentHash: HASH } },
		];
		for (const testCase of cases) {
			resetPreviewState();
			renderPreview(container(), testCase.params, makePreviewResultFromPayload(testCase.snapshot), false);
			fetchCalls = [];

			btn().click();
			await waitForText(/Malformed snapshot marker/);

			expect(fetchCalls, testCase.name).toEqual([]);
			expect(btn().disabled, testCase.name).toBe(true);
		}
	});

	it("rejects malformed supplied metadata for entry-omitted compact markers", async () => {
		const entry = "trusted-100%-日本語.html";
		const cases = [
			{ name: "invalid hash", snapshot: { kind: "preview", url: `/preview/${SESSION_ID}/`, contentHash: "not-a-sha256", artifactId: ARTIFACT_ID } },
			{ name: "invalid full artifact id", snapshot: { kind: "preview", url: `/preview/${SESSION_ID}/`, contentHash: HASH, artifactId: "invalid artifact" } },
			{ name: "invalid aliased artifact id", snapshot: { kind: "preview", url: `/preview/${SESSION_ID}/`, contentHash: HASH, a: "invalid artifact" } },
		];
		for (const testCase of cases) {
			resetPreviewState();
			renderPreview(container(), { file: `/tmp/${entry}` }, makePreviewResultFromPayload(testCase.snapshot), false);
			fetchCalls = [];

			btn().click();
			await waitForText(/Malformed snapshot marker/);

			expect(fetchCalls, testCase.name).toEqual([]);
			expect(btn().disabled, testCase.name).toBe(true);
		}
	});

	it("v3 marker: differing artifact opens a versioned historical tab by artifact id", async () => {
		const oldHash = "c".repeat(64);
		resetPreviewState();
		setPreviewWorkspace(SESSION_ID, oldHash);
		renderPreview(container(), { html: "<p>old card</p>" }, makePreviewResultWithSnapshot("inline.html", HASH, ARTIFACT_ID), false);
		responder = (url, init) => {
			if (init?.method === "POST" && url.includes(`/api/preview/artifacts/${ARTIFACT_ID}/restore`)) return { status: 200, body: { entry: "inline.html", mtime: 456, contentHash: HASH, artifactId: ARTIFACT_ID, url: `/preview/${SESSION_ID}/inline.html` } };
			if (init?.method === "POST" && url.includes("/api/preview/mount")) return { status: 500, body: { error: "unexpected mount fallback" } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/Opened/);

		expect(fetchCalls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
		expect(fetchCalls[1].url).toContain(`/api/preview/artifacts/${ARTIFACT_ID}/restore?sessionId=${SESSION_ID}`);
		expect(JSON.parse(fetchCalls[1].body)).toEqual({ artifactId: ARTIFACT_ID });
		const ps = getPreviewState();
		const tabs = ps.panelTabsBySession[SESSION_ID];
		expect(tabs.map((t: any) => t.id)).toEqual([INLINE_TAB_ID, "preview:entry:inline.html:v:2"]);
		expect(tabs[0].state.contentHash).toBe(oldHash);
		expect(tabs[0].label).toBe("inline.html");
		expect(tabs[1].state.contentHash).toBe(HASH);
		expect(tabs[1].state.artifactId).toBe(ARTIFACT_ID);
		expect(tabs[1].label).toBe("inline.html (v2)");
		expect(ps.panelWorkspaceActiveBySession[SESSION_ID]).toBe("preview:entry:inline.html:v:2");
		expect(ps.previewPanelMountedTabId).toBe("preview:entry:inline.html:v:2");
	});

	it("legacy v3 marker: missing artifact id with restorable params remounts through preview mount", async () => {
		const oldHash = "d".repeat(64);
		const html = "<p>legacy v3 inline</p>";
		resetPreviewState();
		setPreviewWorkspace(SESSION_ID, oldHash);
		renderPreview(container(), { html }, makePreviewResultWithoutArtifact("inline.html", HASH), false);
		responder = (url, init) => {
			if (init?.method === "POST" && url.includes("/api/preview/mount")) return { status: 200, body: { entry: "inline.html", mtime: 567, contentHash: HASH, url: `/preview/${SESSION_ID}/inline.html` } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/Opened/);

		expect(fetchCalls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
		expect(fetchCalls[1].url).toContain(`/api/preview/mount?sessionId=${SESSION_ID}`);
		expect(JSON.parse(fetchCalls[1].body)).toEqual({ html });
		const ps = getPreviewState();
		const tabs = ps.panelTabsBySession[SESSION_ID];
		expect(tabs.map((t: any) => t.id)).toEqual([INLINE_TAB_ID, "preview:entry:inline.html:v:2"]);
		expect(tabs[0].state.contentHash).toBe(oldHash);
		expect(tabs[1].state.contentHash).toBe(HASH);
		expect(tabs[1].state.snapshotHtml).toBe(html);
		expect(tabs[1].state.restoreError).toBeUndefined();
		expect(ps.panelWorkspaceActiveBySession[SESSION_ID]).toBe("preview:entry:inline.html:v:2");
		expect(ps.previewPanelMountedTabId).toBe("preview:entry:inline.html:v:2");
	});

	it("legacy v3 marker: missing artifact id without restorable params selects metadata without POST", async () => {
		const oldHash = "f".repeat(64);
		resetPreviewState();
		setPreviewWorkspace(SESSION_ID, oldHash);
		renderPreview(container(), {}, makePreviewResultWithoutArtifact("inline.html", HASH), false);
		responder = (_url, init) => {
			if (init?.method === "POST") return { status: 500, body: { error: "unexpected restore" } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/Opened/);

		expect(fetchCalls.map((c) => c.method)).toEqual(["PATCH"]);
		const ps = getPreviewState();
		const tabs = ps.panelTabsBySession[SESSION_ID];
		expect(tabs.map((t: any) => t.id)).toEqual([INLINE_TAB_ID, "preview:entry:inline.html:v:2"]);
		expect(tabs[0].state.contentHash).toBe(oldHash);
		expect(tabs[1].state.contentHash).toBe(HASH);
		expect(tabs[1].state.restoreError).toBeUndefined();
		expect(ps.panelWorkspaceActiveBySession[SESSION_ID]).toBe("preview:entry:inline.html:v:2");
		expect(ps.previewPanelMountedTabId).toBe("preview:entry:inline.html:v:2");
	});

	it("v3 marker: artifact restore 404 keeps requested historical tab active with restoreError", async () => {
		const oldHash = "e".repeat(64);
		resetPreviewState();
		setPreviewWorkspace(SESSION_ID, oldHash);
		renderPreview(container(), { html: "<p>must not fallback</p>" }, makePreviewResultWithSnapshot("inline.html", HASH, ARTIFACT_ID), false);
		responder = (url, init) => {
			if (init?.method === "POST" && url.includes(`/api/preview/artifacts/${ARTIFACT_ID}/restore`)) return { status: 404, body: { error: "missing artifact" } };
			if (init?.method === "POST" && url.includes("/api/preview/mount")) return { status: 200, body: { error: "unexpected mount fallback" } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/Artifact evicted/);

		expect(fetchCalls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
		expect(fetchCalls[1].url).toContain(`/api/preview/artifacts/${ARTIFACT_ID}/restore?sessionId=${SESSION_ID}`);
		expect(fetchCalls.some((c) => String(c.url).includes("/api/preview/mount"))).toBe(false);
		const ps = getPreviewState();
		const tabs = ps.panelTabsBySession[SESSION_ID];
		expect(tabs.map((t: any) => t.id)).toEqual([INLINE_TAB_ID, "preview:entry:inline.html:v:2"]);
		expect(tabs[1].state.restoreError.status).toBe(404);
		expect(tabs[1].state.restoreError.message).toContain("evicted");
		expect(tabs[1].state.restoreError.artifactId).toBe(ARTIFACT_ID);
		expect(btn().textContent).toContain("Artifact evicted");
		expect(btn().disabled).toBe(true);
		expect(tabs[0].state.contentHash).toBe(oldHash);
		expect(ps.panelWorkspaceActiveBySession[SESSION_ID]).toBe("preview:entry:inline.html:v:2");
	});

	it("v2 marker: server 404 → button shows 'File no longer available' and stays disabled", async () => {
		const filePath = "/abs/path/to/gone.html";
		renderPreview(container(), { file: filePath }, makeFileResultWithSnapshot(filePath), false);
		responder = (url, init) => {
			if (init?.method === "POST" && url.includes("/api/preview")) return { status: 404, body: { error: "file no longer available" } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/File no longer available/);
		expect(btn().disabled).toBe(true);
	});

	it("click error: shows 'Failed — retry' and re-enables button", async () => {
		const html = "<p>boom</p>";
		renderPreview(container(), { html }, makeResultWithSnapshot(html), false);
		responder = () => ({ status: 500, body: { error: "nope" } });
		fetchCalls = [];

		btn().click();
		await waitForText(/Failed/);
		expect(btn().disabled).toBe(false);
	});
});
