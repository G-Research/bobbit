// Test entry — bundles the tool registry + a synthetic <tool-message> mount
// so we can exercise the lazy-renderer placeholder + resolve flow under a
// file:// fixture.
import { html, render } from "lit";
import { registerLazyToolRenderer, registerToolRenderer, getToolRenderer } from "../../src/ui/tools/renderer-registry.js";
import type { ToolRenderer } from "../../src/ui/tools/types.js";
import "../../src/ui/components/Messages.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

function defer<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeStubRealRenderer(label: string): ToolRenderer {
	return {
		render() {
			return {
				content: html`<button data-real-button>${label}</button>`,
				isCustom: false,
			};
		},
	};
}

function mountToolMessage(slotId: string, toolName: string, toolUseId: string) {
	const slot = document.getElementById(slotId)!;
	slot.innerHTML = "";
	const toolCall = { id: toolUseId, name: toolName, arguments: {} };
	const result = {
		role: "toolResult",
		toolCallId: toolUseId,
		toolName,
		isError: false,
		content: [],
		timestamp: 0,
	};
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

const deferreds = new Map<string, Deferred<ToolRenderer>>();

(window as any).__registerDeferredLazy = (toolName: string) => {
	const d = defer<ToolRenderer>();
	deferreds.set(toolName, d);
	registerLazyToolRenderer(toolName, () => d.promise);
};

(window as any).__resolveDeferredLazy = (toolName: string, label: string) => {
	const d = deferreds.get(toolName);
	if (!d) throw new Error(`no deferred for ${toolName}`);
	d.resolve(makeStubRealRenderer(label));
};

(window as any).__rejectDeferredLazy = (toolName: string, message: string) => {
	const d = deferreds.get(toolName);
	if (!d) throw new Error(`no deferred for ${toolName}`);
	d.reject(new Error(message));
};

(window as any).__registerRejectingLazy = (toolName: string, message: string) => {
	registerLazyToolRenderer(toolName, () => Promise.reject(new Error(message)));
};

// ── { override } precedence helpers (extension-host §4a) ──

/** Register an eager (built-in style) renderer that emits a labelled button. */
(window as any).__registerEagerRenderer = (toolName: string, label: string) => {
	registerToolRenderer(toolName, {
		render() {
			return { content: html`<button data-eager-button>${label}</button>`, isCustom: false };
		},
	});
};

/** Register a pack lazy renderer with { override: true } — should shadow any
 *  eager renderer of the same name and become the effective renderer. */
(window as any).__registerOverrideDeferredLazy = (toolName: string) => {
	const d = defer<ToolRenderer>();
	deferreds.set(toolName, d);
	registerLazyToolRenderer(toolName, () => d.promise, { override: true });
};

/** Resolve getToolRenderer(name) and render its output into a probe slot so the
 *  test can assert which renderer (placeholder / eager / resolved pack) is
 *  effective. Returns nothing; assertions read the DOM. */
(window as any).__renderRegistered = (toolName: string, slotId = "probe") => {
	let slot = document.getElementById(slotId);
	if (!slot) {
		slot = document.createElement("div");
		slot.id = slotId;
		document.body.appendChild(slot);
	}
	const r = getToolRenderer(toolName);
	if (!r) {
		render(html`<span data-no-renderer></span>`, slot);
		return;
	}
	// render() returns a ToolRenderResult { content, isCustom } — mount its content.
	render(r.render(undefined, undefined, false).content, slot);
};

(window as any).__mountToolMessage = mountToolMessage;

(window as any).__waitForRendererLoaded = (toolName: string, timeoutMs = 2000): Promise<void> => {
	return new Promise((resolve, reject) => {
		const onLoad = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail?.toolName === toolName) {
				document.removeEventListener("bobbit-tool-renderer-loaded", onLoad);
				clearTimeout(timer);
				resolve();
			}
		};
		const timer = setTimeout(() => {
			document.removeEventListener("bobbit-tool-renderer-loaded", onLoad);
			reject(new Error(`timeout waiting for renderer ${toolName}`));
		}, timeoutMs);
		document.addEventListener("bobbit-tool-renderer-loaded", onLoad);
	});
};

(window as any).__ready = true;
