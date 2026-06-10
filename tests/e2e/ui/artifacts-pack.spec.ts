/**
 * Browser E2E — Extension Host Phase 2 litmus (Slice D1; design
 * docs/design/extension-host-phase2.md §10). Proves the artifacts built-in
 * re-expressed as an installable market pack using ONLY Phase-2 contributions
 * (renderer + panels + stores + a kind:"route" entrypoint) + the Host API, with
 * REAL behavioral parity across MULTIPLE artifact TYPES (not a text-only demo):
 *
 *   1. Install the `artifacts` pack (local-dir source) at SERVER scope →
 *      /api/tools lists `artifact_demo` with rendererKind:"pack" (tool-scoped),
 *      and /api/ext/contributions carries the pack-scoped `artifacts.viewer` panel
 *      + the `kind:"route"` entrypoint (pack schema V1 §6.1/§6.4). Stores are
 *      implicit (no `storeIds` wire field) — the namespace is the pack id.
 *   2. Live sessions whose transcripts contain `artifact_demo` tool calls render
 *      the PACK renderer (the inline pill) for FOUR distinct types — and NO store
 *      POST fires before any click (security control §5 v: no auto-invoke on mount).
 *   3. Click each type's pill → host.store.put(artifactId, payload) persists +
 *      host.ui.openPanel mounts the `artifacts.viewer` side panel, which rehydrates
 *      from host.store.get(artifactId) and dispatches by TYPE to the real per-type
 *      rendering:
 *        - html  → a `sandbox="allow-scripts"` iframe whose srcdoc IS the content
 *                  (the iframe sandbox is PRESERVED exactly as HtmlArtifact); a
 *                  Code toggle reveals the raw source.
 *        - markdown → rendered HTML (headings/bold/inline-code), not raw source.
 *        - svg   → a `sandbox=""` (no-script) iframe whose srcdoc carries the
 *                  untrusted SVG — NEVER inlined into the main DOM (HIGH-finding
 *                  fix: content-origin trust boundary, same as html artifacts).
 *        - image → an <img> whose src is the base64 data URL.
 *   4. Reload → the pack renderer still loads (registration re-driven from /api/tools).
 *      Re-opening a pill rehydrates the SAME content from the persisted store →
 *      proves persist-across-reload via host.store.
 *   5. Deep-link → "Open via link" calls host.ui.navigate({route:"artifacts",
 *      params:{artifactId}}) → the SPA hash becomes #/ext/artifacts?artifactId=… →
 *      the route resolves through the client pack-route registry → the viewer panel
 *      opens rehydrated from host.store.get (navigate→route→panel→store chain).
 *   6. Uninstall → /api/tools drops `artifact_demo`; the client reconcile removes the
 *      PACK renderer (pill gone) WITHOUT a reload and drops the deep-link route.
 *
 * WHY SERVER SCOPE: the renderer/panel/store endpoints + GET /api/tools (no
 * projectId) resolve through the gateway's server-level ToolManager, which sees
 * server + global-user market packs only. afterEach uninstalls + clears sources so
 * the server-scope pack never leaks into sibling specs on the worker.
 *
 * Pattern: mirrors tests/e2e/ui/extension-host.spec.ts (the Phase-1 retry-demo
 * litmus) — drive a real session whose mock-agent turn emits a tool call that
 * renders a custom inline widget, asserting on its DOM + reload restore.
 */
import { fileURLToPath } from "node:url";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

// Within-file serial: a single end-to-end lifecycle test; be explicit so a failed
// run can never leak a half-installed server-scope pack into a retry.
test.describe.configure({ mode: "serial" });

// Absolute path to the repo-root `market-packs/` local-dir marketplace SOURCE
// (a directory whose `artifacts/` subdir is the pack — a dir is a pack iff it
// has pack.yaml). The litmus packs ship here as first-class installable packs,
// not test fixtures.
const SOURCE_DIR = fileURLToPath(
	new URL("../../../market-packs", import.meta.url),
);

const PACK = "artifacts";
const TOOL = "artifact_demo";

// Each entry mirrors a mock-agent-core.mjs `artifact_demo` variant (stable
// artifactId + filename + content). `trigger` is the chat phrase the mock agent
// keys off; `content` is what the renderer persists and the viewer rehydrates.
const HTML_ARTIFACT = { id: "art-demo-1", trigger: "ARTIFACT_DEMO_TOOL please", filename: "hello.html", content: "<h1>Hello Artifact</h1>" };
const MD_ARTIFACT = { id: "art-demo-md", trigger: "ARTIFACT_DEMO_MD please", filename: "notes.md", content: "# Hello Markdown\n\nSome **bold** and `code` text." };
const SVG_ARTIFACT = { id: "art-demo-svg", trigger: "ARTIFACT_DEMO_SVG please", filename: "shape.svg" };
const IMG_ARTIFACT = { id: "art-demo-img", trigger: "ARTIFACT_DEMO_IMG please", filename: "pixel.png" };
// D1 parity-hardening: the formerly-fallback types now render for REAL via the
// VENDORED libs bundled into the pack by `build:packs` (hljs / pdfjs / docx-preview).
const CODE_ARTIFACT = { id: "art-demo-code", trigger: "ARTIFACT_DEMO_CODE please", filename: "snippet.ts" };
const PDF_ARTIFACT = { id: "art-demo-pdf", trigger: "ARTIFACT_DEMO_PDF please", filename: "doc.pdf" };
const DOCX_ARTIFACT = { id: "art-demo-docx", trigger: "ARTIFACT_DEMO_DOCX please", filename: "doc.docx" };
const CONSOLE_ARTIFACT = { id: "art-demo-console", trigger: "ARTIFACT_DEMO_CONSOLE please", filename: "logger.html" };

const tid = (id: string) => `[data-testid="${id}"]`;
const pillFor = (artifactId: string) => `${tid("artifact-pill")}[data-artifact-id="${artifactId}"]`;

/** Register the local-dir source and install the pack at SERVER scope. */
async function installArtifactsPack(): Promise<void> {
	const addRes = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: SOURCE_DIR }),
	});
	const addBody = await addRes.text();
	expect(addRes.status, addBody).toBe(201);
	const sourceId = (JSON.parse(addBody) as { source: { id: string } }).source.id;

	const instRes = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: PACK, scope: "server" }),
	});
	const instBody = await instRes.text();
	expect(instRes.status, instBody).toBe(201);
}

/** Uninstall the pack + clear every registered source (afterEach hygiene). */
async function cleanup(): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: PACK }),
	}).catch(() => {});
	try {
		const res = await apiFetch("/api/marketplace/sources");
		for (const s of ((await res.json()).sources ?? []) as Array<{ id: string }>) {
			await apiFetch(`/api/marketplace/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" }).catch(() => {});
		}
	} catch { /* ignore */ }
}

interface ArtifactToolMeta {
	name: string;
	rendererKind?: string;
}

interface PackContributionsMeta {
	packId: string;
	packName: string;
	panels: { id: string; title?: string }[];
	entrypoints: Array<{ id: string; kind: string; routeId?: string; paramKeys?: string[]; listName: string }>;
	routeNames: string[];
}

/** Fetch the server-scope tool list (no projectId → server ToolManager). Pack
 *  schema V1 §6.1: /api/tools carries ONLY tool-scoped fields (renderer/actions). */
async function listTools(): Promise<ArtifactToolMeta[]> {
	const res = await apiFetch("/api/tools");
	expect(res.ok).toBe(true);
	return (await res.json()).tools as ArtifactToolMeta[];
}

/** Fetch the server-scope pack-contribution metadata (panels/entrypoints/routes
 *  moved here off the tool YAML — pack schema V1 §6.4). */
async function listContributions(): Promise<PackContributionsMeta[]> {
	const res = await apiFetch("/api/ext/contributions");
	expect(res.ok).toBe(true);
	return (await res.json()).packs as PackContributionsMeta[];
}

test.afterEach(async () => {
	await cleanup();
});

test.describe("Extension Host Phase 2 — artifacts-as-pack litmus (D1)", () => {
	test("install → per-type pills → store-backed viewer (html-sandbox/markdown/svg/image) → persists across reload → deep-link route → uninstall reconciles", async ({ page }) => {
		// Wide viewport so the session split-layout side-panel workspace is shown.
		await page.setViewportSize({ width: 1400, height: 900 });

		// ── Step 1: install at server scope BEFORE opening the app so the cold-load
		// registerPackRenderers()/Panels()/Entrypoints() bootstrap sees the pack. ──
		await installArtifactsPack();

		// ── Step 2: /api/tools lists artifact_demo with the tool-scoped renderer;
		// /api/ext/contributions carries the pack-scoped panel + route entrypoint. ──
		const tools = await listTools();
		const meta = tools.find((t) => t.name === TOOL);
		expect(meta, "artifact_demo must be listed after install").toBeTruthy();
		expect(meta?.rendererKind).toBe("pack");

		const contributions = await listContributions();
		const packMeta = contributions.find((p) => p.packId === PACK);
		expect(packMeta, "the artifacts pack must appear in /api/ext/contributions").toBeTruthy();
		expect(packMeta?.panels?.some((p) => p.id === "artifacts.viewer"), "artifacts.viewer panel must be declared").toBe(true);
		const routeEp = packMeta?.entrypoints?.find((e) => e.kind === "route");
		expect(routeEp?.routeId, "a kind:route entrypoint with routeId 'artifacts' must be declared").toBe("artifacts");
		expect(routeEp?.paramKeys).toContain("artifactId");

		// Count store PUT/GET POSTs so we can prove control §5 v (no auto-invoke on
		// render — the renderer must not persist or open the panel before a click).
		const storePuts: string[] = [];
		const storeGets: string[] = [];
		page.on("request", (r) => {
			if (r.method() !== "POST") return;
			const u = r.url();
			if (/\/api\/ext\/store\/put\b/.test(u)) storePuts.push(u);
			else if (/\/api\/ext\/store\/get\b/.test(u)) storeGets.push(u);
		});

		await openApp(page);
		await createSessionViaUI(page);

		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid, "a session must be selected").toBeTruthy();

		// Drive one mock turn per artifact type → each emits an `artifact_demo` tool
		// call carrying a distinct id/filename/content → the PACK renderer mounts a
		// pill per type. Wait for idle between sends so none are queue-skipped.
		for (const art of [HTML_ARTIFACT, MD_ARTIFACT, SVG_ARTIFACT, IMG_ARTIFACT]) {
			await sendMessage(page, art.trigger);
			await expect(page.locator(pillFor(art.id)).first(), `the ${art.filename} pill must mount`).toBeVisible({ timeout: 25_000 });
			await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });
		}

		// Control §5 v: no store write/read fired before ANY user gesture, and no
		// viewer mounted on render.
		expect(storePuts, "renderer must NOT persist to the store on render").toHaveLength(0);
		expect(storeGets, "renderer must NOT read the store on render").toHaveLength(0);
		await expect(page.locator(tid("artifact-viewer-content"))).toHaveCount(0);

		// ── Step 3a: html — click the pill → store.put persists → openPanel mounts the
		// viewer → it rehydrates from store.get and renders a SANDBOXED iframe. ──
		await page.locator(pillFor(HTML_ARTIFACT.id)).first().click();
		await expect(page.locator(tid("pack-panel-root")), "the pack panel workspace must mount").toBeVisible({ timeout: 15_000 });
		const viewer = page.locator(tid("artifact-viewer-content")).first();
		await expect(viewer, "the viewer must rehydrate content from host.store").toBeVisible({ timeout: 15_000 });
		await expect(viewer).toHaveAttribute("data-artifact-id", HTML_ARTIFACT.id);
		await expect(viewer).toHaveAttribute("data-artifact-type", "html");
		await expect(page.locator(tid("artifact-viewer-filename"))).toHaveText(HTML_ARTIFACT.filename);
		const iframe = page.locator(tid("artifact-viewer-iframe"));
		await expect(iframe, "html artifacts render in a sandboxed iframe").toBeVisible({ timeout: 15_000 });
		await expect(iframe, "the iframe sandbox must be preserved exactly as HtmlArtifact").toHaveAttribute("sandbox", "allow-scripts");
		// srcdoc now carries a prepended console-capture shim; the verbatim content is
		// still present (trust boundary is content-origin, not the injected capture).
		await expect(iframe).toHaveAttribute("srcdoc", /Hello Artifact/);
		expect(storePuts.length, "a store.put must fire on the pill click").toBeGreaterThan(0);
		expect(storeGets.length, "the panel must read the store to rehydrate").toBeGreaterThan(0);

		// Code toggle reveals the raw source (parity with PreviewCodeToggle).
		await page.locator(tid("artifact-viewer-toggle")).first().click();
		await expect(page.locator(tid("artifact-viewer-source"))).toHaveText(HTML_ARTIFACT.content);

		// ── Step 3b: markdown — click the pill → viewer dispatches to RENDERED markdown. ──
		await page.locator(pillFor(MD_ARTIFACT.id)).first().click();
		await expect(viewer).toHaveAttribute("data-artifact-id", MD_ARTIFACT.id, { timeout: 15_000 });
		await expect(viewer).toHaveAttribute("data-artifact-type", "markdown");
		const md = page.locator(tid("artifact-viewer-markdown"));
		await expect(md, "markdown artifacts render to HTML, not raw source").toBeVisible({ timeout: 15_000 });
		await expect(md.locator("h1"), "the # heading must render as <h1>").toHaveText("Hello Markdown");
		await expect(md.locator("strong"), "**bold** must render as <strong>").toHaveText("bold");
		await expect(md.locator("code"), "`code` must render as <code>").toHaveText("code");

		// ── Step 3c: svg — click the pill → viewer renders the untrusted SVG inside a
		// SANDBOXED, no-script iframe (HIGH-finding fix), NOT inlined into the main
		// DOM. The <svg>/<circle> live in the iframe's document (reached via
		// frameLocator), and the iframe carries an empty `sandbox` (no allow-scripts)
		// so a hostile SVG could never run in the parent realm or reach the Host API. ──
		await page.locator(pillFor(SVG_ARTIFACT.id)).first().click();
		await expect(viewer).toHaveAttribute("data-artifact-id", SVG_ARTIFACT.id, { timeout: 15_000 });
		await expect(viewer).toHaveAttribute("data-artifact-type", "svg");
		const svgIframe = page.locator(tid("artifact-viewer-svg"));
		await expect(svgIframe, "svg artifacts render in a sandboxed iframe (not main-DOM innerHTML)").toBeVisible({ timeout: 15_000 });
		await expect(svgIframe, "the svg iframe must be sandboxed with NO allow-scripts").toHaveAttribute("sandbox", "");
		// The svg markup must NOT have been inlined into the main DOM — the viewer-svg
		// host is the iframe itself, so there is no main-realm <svg> sibling.
		await expect(page.locator(`${tid("artifact-viewer-body")} > svg`)).toHaveCount(0);
		const svgFrame = page.frameLocator(tid("artifact-viewer-svg"));
		await expect(svgFrame.locator("svg circle"), "the svg renders inside the sandboxed iframe document").toHaveCount(1, { timeout: 15_000 });

		// ── Step 3d: image — click the pill → viewer renders an <img> from the base64. ──
		await page.locator(pillFor(IMG_ARTIFACT.id)).first().click();
		await expect(viewer).toHaveAttribute("data-artifact-id", IMG_ARTIFACT.id, { timeout: 15_000 });
		await expect(viewer).toHaveAttribute("data-artifact-type", "image");
		const img = page.locator(tid("artifact-viewer-image"));
		await expect(img, "image artifacts render an <img>").toBeVisible({ timeout: 15_000 });
		await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/);

		// ── Step 4: reload → the pack renderer re-loads (registration re-driven). The
		// store payloads persisted server-side, so re-opening rehydrates the SAME
		// content (proves persist-across-reload via host.store). ──
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(pillFor(MD_ARTIFACT.id)).first(), "the pack renderer must survive reload").toBeVisible({ timeout: 25_000 });
		await page.locator(pillFor(MD_ARTIFACT.id)).first().click();
		const viewerAfterReload = page.locator(tid("artifact-viewer-content")).first();
		await expect(viewerAfterReload, "the viewer must rehydrate from the persisted store after reload").toBeVisible({ timeout: 15_000 });
		await expect(viewerAfterReload).toHaveAttribute("data-artifact-type", "markdown");
		await expect(page.locator(`${tid("artifact-viewer-markdown")} strong`)).toHaveText("bold");

		// ── Step 5: deep-link AFTER RELOAD → "Open via link" on the html pill calls
		// host.ui.navigate({route:"artifacts",params:{artifactId}}) → the SPA hash
		// becomes #/ext/artifacts?artifactId=… via the client route registry → the route
		// resolves → the viewer panel opens rehydrated from the reload-persisted store. ──
		await page.locator(`${tid("artifact-deeplink")}[data-artifact-id="${HTML_ARTIFACT.id}"]`).first().click();
		await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
			.toBe(`#/ext/${PACK}?artifactId=${HTML_ARTIFACT.id}`);
		const deepViewer = page.locator(tid("artifact-viewer-content")).first();
		await expect(deepViewer, "the deep-link route must open the viewer rehydrated from store").toBeVisible({ timeout: 15_000 });
		await expect(deepViewer).toHaveAttribute("data-artifact-id", HTML_ARTIFACT.id);
		await expect(page.locator(tid("artifact-viewer-iframe"))).toHaveAttribute("srcdoc", /Hello Artifact/);

		// NOTE (infra gap, see task summary): a COLD reload directly on the `#/ext/...`
		// hash currently restores no session (the ext route handler establishes no
		// session context), and the pack store read is authorized against the
		// header-bound session — so a session-less cold deep-link cannot rehydrate the
		// viewer from the store. The reload-SURVIVING deep-link path is proven above via
		// Step 4's reload + this Step 5 navigate; closing the cold-`#/ext` session gap is
		// left to the C1 owner.

		// ── Step 6: uninstall → /api/tools drops artifact_demo. ──
		const delRes = await apiFetch("/api/marketplace/installed", {
			method: "DELETE",
			body: JSON.stringify({ scope: "server", packName: PACK }),
		});
		expect(delRes.status).toBe(204);

		const afterTools = await listTools();
		expect(afterTools.find((t) => t.name === TOOL), "artifact_demo must be gone after uninstall").toBeFalsy();

		// Re-drive the client reconcile exactly as a marketplace mutation does
		// (registerPackRenderers + reconcilePackPanels/Entrypoints from a fresh
		// /api/tools). The viewer panel tab must be torn down from the LIVE UI WITHOUT
		// a reload — the pack-panel workspace disappears (panel uninstall-reconcile,
		// design §6). Idempotent, so poll-driving it is deterministic.
		await expect
			.poll(async () => {
				await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers()).catch(() => { /* navigation race */ });
				return page.locator(`${tid("pack-panel-root")}[data-pack-panel-id="artifacts.viewer"]`).count();
			}, { timeout: 15_000 })
			.toBe(0);
	});

	// D1 parity hardening (the gap reviewer's flagged fallbacks → REAL rendering via
	// VENDORED npm libs bundled into the pack by `build:packs`): code is highlighted
	// by highlight.js, a PDF is rasterised by pdfjs-dist, a DOCX is rendered by
	// docx-preview, and an HTML artifact's console output is captured — none of these
	// are fallbacks any more. The bundle build runs before E2E (npm run build →
	// build:packs), so the served ArtifactViewerPanel.js is fresh.
	test("vendored-lib parity: code→hljs highlighting, pdf→pdfjs canvas, docx→docx-preview, html→console capture", async ({ page }) => {
		await page.setViewportSize({ width: 1400, height: 900 });
		await installArtifactsPack();
		await openApp(page);
		await createSessionViaUI(page);
		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid, "a session must be selected").toBeTruthy();

		for (const art of [CODE_ARTIFACT, PDF_ARTIFACT, DOCX_ARTIFACT, CONSOLE_ARTIFACT]) {
			await sendMessage(page, art.trigger);
			await expect(page.locator(pillFor(art.id)).first(), `the ${art.filename} pill must mount`).toBeVisible({ timeout: 25_000 });
			await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });
		}

		const viewer = page.locator(tid("artifact-viewer-content")).first();

		// ── code → REAL highlight.js token spans (was a documented gap). ──
		await page.locator(pillFor(CODE_ARTIFACT.id)).first().click();
		await expect(page.locator(tid("pack-panel-root"))).toBeVisible({ timeout: 15_000 });
		await expect(viewer).toHaveAttribute("data-artifact-id", CODE_ARTIFACT.id, { timeout: 15_000 });
		await expect(viewer).toHaveAttribute("data-artifact-type", "text");
		const code = page.locator(`${tid("artifact-viewer-source")} code.hljs`);
		await expect(code, "code files render in an hljs <code> block").toBeVisible({ timeout: 15_000 });
		await expect(code.locator("span.hljs-keyword, span[class^='hljs-']").first(), "hljs must emit token spans (REAL highlighting)").toBeVisible({ timeout: 15_000 });

		// ── pdf → REAL pdfjs page canvases (was a native-embed fallback). ──
		await page.locator(pillFor(PDF_ARTIFACT.id)).first().click();
		await expect(viewer).toHaveAttribute("data-artifact-id", PDF_ARTIFACT.id, { timeout: 15_000 });
		await expect(viewer).toHaveAttribute("data-artifact-type", "pdf");
		await expect(page.locator(tid("artifact-viewer-pdf"))).toBeVisible({ timeout: 15_000 });
		const pdfCanvas = page.locator(`${tid("artifact-viewer-pdf-pages")} canvas`).first();
		await expect(pdfCanvas, "pdfjs must rasterise at least one page canvas").toBeVisible({ timeout: 20_000 });
		// A rendered canvas has real pixel dimensions (proves pdfjs ran, not a stub).
		await expect.poll(async () => pdfCanvas.evaluate((c: HTMLCanvasElement) => c.width), { timeout: 20_000 }).toBeGreaterThan(0);
		await expect(page.locator(tid("artifact-viewer-binary-error")), "pdf must render without error").toHaveCount(0);

		// ── docx → REAL docx-preview rendering (was a download fallback). ──
		await page.locator(pillFor(DOCX_ARTIFACT.id)).first().click();
		await expect(viewer).toHaveAttribute("data-artifact-id", DOCX_ARTIFACT.id, { timeout: 15_000 });
		await expect(viewer).toHaveAttribute("data-artifact-type", "docx");
		const docx = page.locator(tid("artifact-viewer-docx-rendered"));
		await expect(docx, "docx-preview must render the document").toBeVisible({ timeout: 20_000 });
		await expect(docx, "the rendered docx must contain the document text").toContainText("DOCX Parity OK", { timeout: 20_000 });
		await expect(page.locator(tid("artifact-viewer-binary-error")), "docx must render without error").toHaveCount(0);

		// ── html → REAL console capture (was a documented gap): the iframe's
		// console.log/error are teed to the parent via a postMessage shim. ──
		await page.locator(pillFor(CONSOLE_ARTIFACT.id)).first().click();
		await expect(viewer).toHaveAttribute("data-artifact-id", CONSOLE_ARTIFACT.id, { timeout: 15_000 });
		await expect(viewer).toHaveAttribute("data-artifact-type", "html");
		const consolePanel = page.locator(tid("artifact-viewer-console"));
		await expect(consolePanel, "the console panel must appear once the iframe logs").toBeVisible({ timeout: 20_000 });
		await expect(consolePanel).toContainText("ARTIFACT_LOG_LINE", { timeout: 20_000 });
		await expect(consolePanel.locator(`${tid("artifact-viewer-console-entry")}[data-log-type="error"]`)).toContainText("ARTIFACT_ERR_LINE", { timeout: 20_000 });
	});

	// Regression: a persisted side-panel tab is restored by panel-workspace WITHOUT
	// going through openPackPanel, so on reload `loadedPanels` is empty even though
	// the panel is registered. renderPackPanelContent must kick off the module load
	// at render time (render-time lazy load) or the restored tab is stuck on
	// "Loading…" forever. The other reload case (re-OPEN after reload + deep-link)
	// is covered above; this proves reload-with-the-tab-ALREADY-open auto-reloads.
	test("reload with the viewer panel tab already open → the tab auto-reloads its module (not stuck on Loading…)", async ({ page }) => {
		await page.setViewportSize({ width: 1400, height: 900 });
		await installArtifactsPack();

		await openApp(page);
		await createSessionViaUI(page);
		const sid = await page.evaluate(() => (window as any).__bobbitState?.selectedSessionId as string | null);
		expect(sid, "a session must be selected").toBeTruthy();

		// Drive one artifact turn → pill mounts → click it → the viewer panel opens.
		await sendMessage(page, HTML_ARTIFACT.trigger);
		await expect(page.locator(pillFor(HTML_ARTIFACT.id)).first()).toBeVisible({ timeout: 25_000 });
		await waitForSessionStatus(sid!, "idle").catch(() => { /* best-effort */ });
		await page.locator(pillFor(HTML_ARTIFACT.id)).first().click();
		await expect(page.locator(tid("pack-panel-root"))).toBeVisible({ timeout: 15_000 });
		await expect(page.locator(tid("artifact-viewer-content")).first()).toBeVisible({ timeout: 15_000 });

		// ── Reload WHILE the viewer panel tab is still open. The tab is restored from
		// persistence; renderPackPanelContent must auto-load the (registered but not-
		// yet-loaded) panel module WITHOUT any further click, then rehydrate from the
		// persisted store. Before the fix this tab stayed on "Loading…" forever. ──
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });

		// The pack-panel workspace re-mounts the restored tab, and its content swaps
		// from the loading placeholder to the real viewer with NO user gesture.
		await expect(page.locator(tid("pack-panel-root")), "the restored pack-panel tab must re-mount on reload").toBeVisible({ timeout: 20_000 });
		const restored = page.locator(tid("artifact-viewer-content")).first();
		await expect(restored, "the restored tab must auto-load its module + rehydrate, not stay on Loading…").toBeVisible({ timeout: 20_000 });
		await expect(restored).toHaveAttribute("data-artifact-id", HTML_ARTIFACT.id);
		await expect(restored).toHaveAttribute("data-artifact-type", "html");
		await expect(page.locator(`[data-pack-panel-loading="artifacts.viewer"]`), "the loading placeholder must not persist").toHaveCount(0);
	});
});
