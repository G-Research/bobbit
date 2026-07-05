// Migrated from tests/lazy-renderer-placeholder.spec.ts (v2-dom tier).
// Drives the REAL tool-renderer registry + <tool-message> lit component under
// happy-dom, replacing the esbuild file:// bundle and its window-exposed helpers
// (ported here as module functions). Pins: the loading placeholder card + resolve
// flow, loader-rejection fallback, pack { override } precedence + uninstall
// reconciliation, and the generation-guarded stale-load drops (TOCTOU + the
// writer-ordering matrix). No geometry — pure registry/event/lit logic.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRenderer } from "../../src/ui/tools/types.js";

// Under vitest pool:forks + isolate:false each test file runs in its OWN
// happy-dom realm while the module graph is cached across files in the fork — so
// Messages.js's top-level @customElement define only registers <tool-message> in
// the FIRST importing file's realm. `vi.resetModules()` forces this file to
// re-evaluate the graph fresh so the decorator defines the tag in THIS realm; we
// bind lit's html/render + the registry API from that same fresh graph (dynamic
// import) so the renderers and this test share one lit + registry instance.
// session-manager is imported first to initialize the pack-panels ⇄
// session-manager cycle before Messages.js's app/* imports hit it as a TDZ error.
let html: typeof import("lit").html;
let render: typeof import("lit").render;
let registerLazyToolRenderer: typeof import("../../src/ui/tools/renderer-registry.js").registerLazyToolRenderer;
let registerToolRenderer: typeof import("../../src/ui/tools/renderer-registry.js").registerToolRenderer;
let unregisterPackRenderer: typeof import("../../src/ui/tools/renderer-registry.js").unregisterPackRenderer;
let getToolRenderer: typeof import("../../src/ui/tools/renderer-registry.js").getToolRenderer;
let TOOL_RENDERER_LOADED_EVENT: string;

beforeAll(async () => {
	vi.resetModules();
	({ html, render } = await import("lit"));
	await import("../../src/app/session-manager.js");
	({ registerLazyToolRenderer, registerToolRenderer, unregisterPackRenderer, getToolRenderer, TOOL_RENDERER_LOADED_EVENT } = await import("../../src/ui/tools/renderer-registry.js"));
	await import("../../src/ui/components/Messages.js");
	await customElements.whenDefined("tool-message");
	document.addEventListener(TOOL_RENDERER_LOADED_EVENT, (e) => {
		const name = (e as CustomEvent).detail?.toolName;
		if (typeof name === "string") loadedEventLog.push(name);
	});
});

// ── Helpers (ported from lazy-renderer-placeholder-entry.ts) ──────────

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (r?: unknown) => void; }
function defer<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	let reject!: (r?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function makeStubRealRenderer(label: string): ToolRenderer {
	return { render() { return { content: html`<button data-real-button>${label}</button>`, isCustom: false }; } };
}

const deferreds = new Map<string, Deferred<ToolRenderer>>();
const loadedEventLog: string[] = [];
// (the TOOL_RENDERER_LOADED_EVENT listener is registered in beforeAll, once the
// event-name constant has been bound from the freshly re-evaluated registry.)

const registerDeferredLazy = (toolName: string) => {
	const d = defer<ToolRenderer>();
	deferreds.set(toolName, d);
	registerLazyToolRenderer(toolName, () => d.promise);
};
const resolveDeferredLazy = (toolName: string, label: string) => {
	const d = deferreds.get(toolName);
	if (!d) throw new Error(`no deferred for ${toolName}`);
	d.resolve(makeStubRealRenderer(label));
};
const registerRejectingLazy = (toolName: string, message: string) => {
	registerLazyToolRenderer(toolName, () => Promise.reject(new Error(message)));
};
const registerKeyedLazy = (toolName: string, key: string, override = false) => {
	const d = defer<ToolRenderer>();
	deferreds.set(key, d);
	registerLazyToolRenderer(toolName, () => d.promise, override ? { override: true } : undefined);
};
const resolveKeyedLazy = (key: string, label: string) => {
	const d = deferreds.get(key);
	if (!d) throw new Error(`no deferred for key ${key}`);
	d.resolve(makeStubRealRenderer(label));
};
const loadedEventCount = (toolName: string): number => loadedEventLog.filter((n) => n === toolName).length;
const flush = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 30)); };
const registerEagerRenderer = (toolName: string, label: string) => {
	registerToolRenderer(toolName, { render() { return { content: html`<button data-eager-button>${label}</button>`, isCustom: false }; } });
};
const registerOverrideDeferredLazy = (toolName: string) => {
	const d = defer<ToolRenderer>();
	deferreds.set(toolName, d);
	registerLazyToolRenderer(toolName, () => d.promise, { override: true });
};
const unregisterPack = (toolName: string) => unregisterPackRenderer(toolName);

function ensureSlot(id: string): HTMLElement {
	let slot = document.getElementById(id);
	if (!slot) { slot = document.createElement("div"); slot.id = id; document.body.appendChild(slot); }
	return slot;
}

const renderRegistered = (toolName: string, slotId = "probe") => {
	const slot = ensureSlot(slotId);
	const r = getToolRenderer(toolName);
	if (!r) { render(html`<span data-no-renderer></span>`, slot); return; }
	render(r.render(undefined as any, undefined as any, false).content, slot);
};

function mountToolMessage(slotId: string, toolName: string, toolUseId: string) {
	const slot = ensureSlot(slotId);
	slot.innerHTML = "";
	const toolCall = { id: toolUseId, name: toolName, arguments: {} };
	const result = { role: "toolResult", toolCallId: toolUseId, toolName, isError: false, content: [], timestamp: 0 };
	render(
		html`<tool-message
			.toolCall=${toolCall}
			.tool=${{ name: toolName }}
			.result=${result}
			.pending=${false}
			.aborted=${false}
			.isStreaming=${false}
		></tool-message>`,
		slot,
	);
}

function waitForRendererLoaded(toolName: string, timeoutMs = 2000): Promise<void> {
	return new Promise((resolve, reject) => {
		const onLoad = (e: Event) => {
			if ((e as CustomEvent).detail?.toolName === toolName) {
				document.removeEventListener(TOOL_RENDERER_LOADED_EVENT, onLoad);
				clearTimeout(timer);
				resolve();
			}
		};
		const timer = setTimeout(() => {
			document.removeEventListener(TOOL_RENDERER_LOADED_EVENT, onLoad);
			reject(new Error(`timeout waiting for renderer ${toolName}`));
		}, timeoutMs);
		document.addEventListener(TOOL_RENDERER_LOADED_EVENT, onLoad);
	});
}

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => document.querySelectorAll(sel);
async function toolMessageSettled() {
	const el = document.querySelector("tool-message") as any;
	if (el?.updateComplete) await el.updateComplete;
}

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { document.body.innerHTML = ""; });

describe("Lazy tool renderer placeholder", () => {
	it("placeholder shows card + disabled button; resolves to real renderer in-place", async () => {
		registerDeferredLazy("test_lazy_tool");
		mountToolMessage("slot", "test_lazy_tool", "tool-1");
		await toolMessageSettled();

		expect(qa("tool-message .border.rounded-md").length).toBe(1);
		const loadingBtn = q("tool-message [data-lazy-renderer-placeholder-btn]") as HTMLButtonElement;
		expect(loadingBtn).toBeTruthy();
		expect(loadingBtn.hasAttribute("disabled")).toBe(true);
		expect(loadingBtn.textContent).toMatch(/Loading/);
		expect(q("tool-message [data-real-button]")).toBeNull();

		const wait = waitForRendererLoaded("test_lazy_tool");
		resolveDeferredLazy("test_lazy_tool", "REAL_BUTTON");
		await wait;
		await toolMessageSettled();

		expect(q("tool-message [data-real-button]")?.textContent).toContain("REAL_BUTTON");
		expect(qa("tool-message .border.rounded-md").length).toBe(1);
		expect(q("tool-message [data-lazy-renderer-placeholder-btn]")).toBeNull();
	});

	it("loader rejection renders error fallback instead of indefinite spinner", async () => {
		registerRejectingLazy("test_failing_tool", "boom");
		const wait = waitForRendererLoaded("test_failing_tool");
		mountToolMessage("slot", "test_failing_tool", "tool-fail");
		await wait;
		await toolMessageSettled();

		expect(qa("tool-message .border.rounded-md").length).toBe(1);
		expect(q("tool-message")?.textContent).toMatch(/Renderer failed to load/);
		expect(q("tool-message [data-lazy-renderer-placeholder-btn]")).toBeNull();
	});
});

describe("Pack renderer { override } precedence (extension-host §4a)", () => {
	it("override shadows a pre-registered eager renderer; resolves to the pack renderer", async () => {
		registerEagerRenderer("shadow_tool", "EAGER");
		registerOverrideDeferredLazy("shadow_tool");
		renderRegistered("shadow_tool");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(1);
		expect(qa("#probe [data-eager-button]").length).toBe(0);

		registerEagerRenderer("shadow_tool", "LATE_EAGER");
		renderRegistered("shadow_tool");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(1);
		expect(qa("#probe [data-eager-button]").length).toBe(0);

		const wait = waitForRendererLoaded("shadow_tool");
		resolveDeferredLazy("shadow_tool", "PACK_RENDERER");
		await wait;
		renderRegistered("shadow_tool");
		expect(q("#probe [data-real-button]")?.textContent).toContain("PACK_RENDERER");
		expect(qa("#probe [data-eager-button]").length).toBe(0);
	});

	it("unregister restores the displaced built-in renderer in place (uninstall reconciliation §4a)", async () => {
		registerEagerRenderer("reconcile_tool", "BUILTIN");
		registerOverrideDeferredLazy("reconcile_tool");
		renderRegistered("reconcile_tool");
		const wait = waitForRendererLoaded("reconcile_tool");
		resolveDeferredLazy("reconcile_tool", "PACK_RENDERER");
		await wait;
		renderRegistered("reconcile_tool");
		expect(q("#probe [data-real-button]")?.textContent).toContain("PACK_RENDERER");
		expect(qa("#probe [data-eager-button]").length).toBe(0);

		unregisterPack("reconcile_tool");
		renderRegistered("reconcile_tool");
		expect(q("#probe [data-eager-button]")?.textContent).toContain("BUILTIN");
		expect(qa("#probe [data-real-button]").length).toBe(0);
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(0);
	});

	it("unregister restores a displaced LAZY builtin loader (not just eager) §4a", async () => {
		registerKeyedLazy("lazy_builtin_tool", "BUILTIN_LOADER", false);
		registerKeyedLazy("lazy_builtin_tool", "PACK_LOADER", true);
		renderRegistered("lazy_builtin_tool");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(1);

		unregisterPack("lazy_builtin_tool");
		renderRegistered("lazy_builtin_tool");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(1);
		expect(qa("#probe [data-no-renderer]").length).toBe(0);

		const wait = waitForRendererLoaded("lazy_builtin_tool");
		resolveKeyedLazy("BUILTIN_LOADER", "LAZY_BUILTIN");
		await wait;
		renderRegistered("lazy_builtin_tool");
		expect(q("#probe [data-real-button]")?.textContent).toContain("LAZY_BUILTIN");
	});

	it("unregister of a pack tool with no built-in falls back to default (no renderer)", async () => {
		registerOverrideDeferredLazy("orphan_pack_tool");
		renderRegistered("orphan_pack_tool");
		const wait = waitForRendererLoaded("orphan_pack_tool");
		resolveDeferredLazy("orphan_pack_tool", "PACK_ONLY");
		await wait;
		renderRegistered("orphan_pack_tool");
		expect(q("#probe [data-real-button]")?.textContent).toContain("PACK_ONLY");

		unregisterPack("orphan_pack_tool");
		renderRegistered("orphan_pack_tool");
		expect(qa("#probe [data-no-renderer]").length).toBe(1);
		expect(qa("#probe [data-real-button]").length).toBe(0);
	});

	it("an unshadowed built-in renderer is untouched by override registrations", async () => {
		registerEagerRenderer("plain_tool", "PLAIN");
		registerOverrideDeferredLazy("other_tool");
		renderRegistered("plain_tool");
		expect(q("#probe [data-eager-button]")?.textContent).toContain("PLAIN");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(0);
	});
});

describe("In-flight lazy load TOCTOU guard (generation token)", () => {
	it("unregister while a load is in flight: a late resolve does NOT resurrect the pack renderer", async () => {
		registerEagerRenderer("race_tool", "BUILTIN");
		registerOverrideDeferredLazy("race_tool");
		renderRegistered("race_tool");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(1);

		unregisterPack("race_tool");
		renderRegistered("race_tool");
		const countAfterUnregister = loadedEventCount("race_tool");
		expect(q("#probe [data-eager-button]")?.textContent).toContain("BUILTIN");

		resolveDeferredLazy("race_tool", "STALE_PACK");
		await flush();
		renderRegistered("race_tool");
		const countAfterResolve = loadedEventCount("race_tool");

		expect(q("#probe [data-eager-button]")?.textContent).toContain("BUILTIN");
		expect(qa("#probe [data-real-button]").length).toBe(0);
		expect(countAfterResolve).toBe(countAfterUnregister);
	});

	it("re-register a different renderer while a load is in flight: the stale load is ignored, the new one wins", async () => {
		registerKeyedLazy("rereg_tool", "A", true);
		renderRegistered("rereg_tool");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(1);

		registerKeyedLazy("rereg_tool", "B", true);
		renderRegistered("rereg_tool");

		resolveKeyedLazy("A", "STALE_A");
		await flush();
		renderRegistered("rereg_tool");
		expect(qa("#probe [data-real-button]").length).toBe(0);

		resolveKeyedLazy("B", "FRESH_B");
		await flush();
		renderRegistered("rereg_tool");
		expect(q("#probe [data-real-button]")?.textContent).toContain("FRESH_B");
	});
});

describe("Writer-ordering matrix: stale deferred applies are structurally dropped (Wave 10C)", () => {
	it("lazy-start → eager registerToolRenderer → stale lazy resolves: the EAGER renderer wins (eager-gap fix)", async () => {
		registerKeyedLazy("eager_gap_tool", "LAZY", false);
		renderRegistered("eager_gap_tool");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(1);

		registerEagerRenderer("eager_gap_tool", "EAGER_WINS");
		renderRegistered("eager_gap_tool");
		const countAfterEager = loadedEventCount("eager_gap_tool");
		expect(q("#probe [data-eager-button]")?.textContent).toContain("EAGER_WINS");

		resolveKeyedLazy("LAZY", "STALE_LAZY");
		await flush();
		renderRegistered("eager_gap_tool");
		const countAfterResolve = loadedEventCount("eager_gap_tool");
		expect(q("#probe [data-eager-button]")?.textContent).toContain("EAGER_WINS");
		expect(qa("#probe [data-real-button]").length).toBe(0);
		expect(countAfterResolve).toBe(countAfterEager);
	});

	it("lazy-start → pack {override} → stale lazy resolves: the PACK renderer wins", async () => {
		registerKeyedLazy("override_race_tool", "BUILTIN_LAZY", false);
		renderRegistered("override_race_tool");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(1);

		registerKeyedLazy("override_race_tool", "PACK", true);
		renderRegistered("override_race_tool");

		resolveKeyedLazy("BUILTIN_LAZY", "STALE_BUILTIN");
		await flush();
		renderRegistered("override_race_tool");
		expect(qa("#probe [data-real-button]").length).toBe(0);

		const wait = waitForRendererLoaded("override_race_tool");
		resolveKeyedLazy("PACK", "PACK_WINS");
		await wait;
		renderRegistered("override_race_tool");
		expect(q("#probe [data-real-button]")?.textContent).toContain("PACK_WINS");
	});

	it("lazy-start → unregisterPackRenderer → stale lazy resolves: it does NOT resurrect", async () => {
		registerEagerRenderer("unreg_race_tool", "BUILTIN");
		registerOverrideDeferredLazy("unreg_race_tool");
		renderRegistered("unreg_race_tool");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(1);

		unregisterPack("unreg_race_tool");
		renderRegistered("unreg_race_tool");
		const countAfterUnregister = loadedEventCount("unreg_race_tool");
		expect(q("#probe [data-eager-button]")?.textContent).toContain("BUILTIN");

		resolveDeferredLazy("unreg_race_tool", "STALE_PACK");
		await flush();
		renderRegistered("unreg_race_tool");
		const countAfterResolve = loadedEventCount("unreg_race_tool");
		expect(q("#probe [data-eager-button]")?.textContent).toContain("BUILTIN");
		expect(qa("#probe [data-real-button]").length).toBe(0);
		expect(countAfterResolve).toBe(countAfterUnregister);
	});

	it("eager-then-override: a stale eager-era lazy load cannot resurrect after override claims the name", async () => {
		registerKeyedLazy("eager_then_override", "OLD_LAZY", false);
		renderRegistered("eager_then_override");
		expect(qa("#probe [data-lazy-renderer-placeholder-btn]").length).toBe(1);

		registerEagerRenderer("eager_then_override", "MID_EAGER");
		registerKeyedLazy("eager_then_override", "PACK", true);
		renderRegistered("eager_then_override");

		resolveKeyedLazy("OLD_LAZY", "STALE_OLD");
		await flush();
		renderRegistered("eager_then_override");
		expect(qa("#probe [data-real-button]").length).toBe(0);
		expect(qa("#probe [data-eager-button]").length).toBe(0);

		const wait = waitForRendererLoaded("eager_then_override");
		resolveKeyedLazy("PACK", "PACK_WINS");
		await wait;
		renderRegistered("eager_then_override");
		expect(q("#probe [data-real-button]")?.textContent).toContain("PACK_WINS");
	});
});
