import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ui-fixtures/preview-archived-snapshot.spec.ts (v2-dom tier).
// Acceptance criterion #8: archived sessions stamped with v1 / v2 markers still
// render an Open button via the read-only legacy compatibility path. The legacy
// spec esbuild-bundled the preview-renderer file:// fixture; this port renders the
// REAL PreviewOpenRenderer under happy-dom against app state + a mocked fetch
// (same harness as preview-renderer.test.ts).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let PreviewOpenRenderer: typeof import("../../../src/ui/tools/renderers/PreviewRenderer.js").PreviewOpenRenderer;
let render: typeof import("lit").render;
let state: any;

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const MARKER_V1 = "__preview_snapshot_v1__\n";
const MARKER_V2 = "__preview_snapshot_v2__\n";

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

function v1Result(html: string) {
	return {
		role: "toolResult", toolCallId: "tool-v1", toolName: "preview_open", isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
			{ type: "text", text: MARKER_V1 + html },
		],
		timestamp: Date.now(),
	};
}

function v2Result(filePath: string) {
	return {
		role: "toolResult", toolCallId: "tool-v2", toolName: "preview_open", isError: false,
		content: [
			{ type: "text", text: "Preview panel is open and will auto-update." },
			{ type: "text", text: MARKER_V2 + JSON.stringify({ kind: "file", path: filePath }) + "\n" },
		],
		timestamp: Date.now(),
	};
}

function renderPreview(container: HTMLElement, params: any, result: any = undefined, isStreaming = false) {
	const out = new PreviewOpenRenderer().render(params, result, isStreaming, { sessionId: SESSION_ID, toolUseId: "tool-1" } as any);
	render(out.content, container);
}

function container(): HTMLElement {
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
	({ PreviewOpenRenderer } = await import("../../../src/ui/tools/renderers/PreviewRenderer.js"));
	({ render } = await import("lit"));
	({ state } = await import("../../../src/app/state.js"));
	__syncCE();
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

describe("Archived-session snapshot compatibility (criterion 8)", () => {
	it("v1 marker: Open button enabled; click POSTs /api/preview/mount with {html}", async () => {
		const html = "<!DOCTYPE html><body><h1>archived-v1</h1></body>";
		renderPreview(container(), { html }, v1Result(html), false);
		fetchCalls = [];

		const b = btn();
		expect(b.disabled).toBe(false);
		expect(b.textContent?.trim()).toBe("Open");

		b.click();
		await waitForText(/Opened/);

		const post = fetchCalls.find((c) => c.method === "POST" && String(c.url).includes("/api/preview/mount"));
		expect(post, `expected POST /api/preview/mount, got: ${JSON.stringify(fetchCalls)}`).toBeTruthy();
		expect(String(post!.url)).toContain(`sessionId=${SESSION_ID}`);
		const body = JSON.parse(post!.body);
		expect(body.html).toBe(html);
		expect(body.html).not.toContain("__preview_snapshot_v1__");
		expect(body.file).toBeUndefined();
	});

	it("v2 marker: Open button enabled; click POSTs /api/preview/mount with {file}", async () => {
		const filePath = "/abs/path/to/report.html";
		renderPreview(container(), { file: filePath }, v2Result(filePath), false);
		fetchCalls = [];

		const b = btn();
		expect(b.disabled).toBe(false);

		b.click();
		await waitForText(/Opened/);

		const post = fetchCalls.find((c) => c.method === "POST" && String(c.url).includes("/api/preview/mount"));
		expect(post).toBeTruthy();
		const body = JSON.parse(post!.body);
		expect(body.file).toBe(filePath);
		expect(body.html).toBeUndefined();
		expect(body.kind).toBeUndefined();
	});

	it("v2 marker: server 404 → button disabled with 'File no longer available'", async () => {
		const filePath = "/abs/path/to/missing.html";
		renderPreview(container(), { file: filePath }, v2Result(filePath), false);
		responder = (url, init) => {
			if (init?.method === "POST" && String(url).includes("/api/preview/mount")) return { status: 404, body: { error: "file no longer available" } };
			return { status: 200, body: { ok: true } };
		};
		fetchCalls = [];

		btn().click();
		await waitForText(/File no longer available/);
		expect(btn().disabled).toBe(true);
	});
});
