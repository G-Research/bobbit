// Shared custom-element registration bridge for the v2-dom (happy-dom) tier.
//
// WHY THIS EXISTS
// vitest runs with `pool:"forks", isolate:false` (see vitest.config.ts). Under
// that config the module registry is shared across all test files in a fork,
// but happy-dom hands each test file a BRAND-NEW window (fresh `customElements`
// registry). Two independent problems follow, both fixed here:
//
//  (1) `@customElement("x")` is a module-eval side-effect that runs exactly ONCE
//      — against whichever file's window first imported that module. Every other
//      file gets a fresh registry with `x` missing, its cached import never
//      re-runs the define, and `document.createElement("x")` yields an inert,
//      un-upgraded element.
//
//  (2) lit-html captures `const d = document` at MODULE INIT (lit-html.js) and
//      builds every template via `d.createElement("template")`. So all elements
//      produced by `render(html`...`)` are parsed in the window that first
//      imported lit-html — NOT the current test's window. happy-dom upgrades a
//      custom element at parse time against THAT document's registry; if the tag
//      isn't defined there, the element is created plain and is never re-upgraded
//      when cloned into the current window's container — hence
//      "createRenderRoot is not a function" on connect.
//
// FIX
//  - `import "lit"` at the very top so lit-html initializes in THIS (the first)
//    window, pinning its captured `d` document to `litDocument` below.
//  - Patch `CustomElementRegistry.prototype.define` (once per fork) to record
//    every (tag -> class) into a fork-global map.
//  - `syncCustomElements()` replays every recorded definition into BOTH the
//    current window's registry (for `createElement` paths) AND lit-html's pinned
//    document's registry (for `render(html`...`)` template paths). Call it in a
//    top-level `beforeAll` in every dom test file.
//
// This keeps a SINGLE lit copy — no `vi.resetModules()` / cache-busting dynamic
// imports (which spawn a second lit realm → "createRenderRoot is not a function"
// for a different reason). Import this module FIRST in every dom test file.

// Force lit-html to evaluate now, in the first-run window, so its internal
// captured `document` equals the `litDocument` we snapshot on the next line.
import "lit";

type CE = CustomElementConstructor;

const recorded = new Map<string, CE>();

// lit-html captured `document` at init === the current document/registry at this
// point, because this module (and its `import "lit"`) is imported FIRST in every
// file and the first-executed file triggers both evaluations in one window.
const litDocument: Document | undefined = (globalThis as any).document;
const litCustomElements: CustomElementRegistry | undefined = (globalThis as any).customElements;

const proto: any = (globalThis as any).CustomElementRegistry?.prototype;
if (proto && !proto.__bobbitDomBridge) {
	const origDefine: (tag: string, cls: CE, opts?: ElementDefinitionOptions) => void = proto.define;
	proto.define = function patchedDefine(tag: string, cls: CE, opts?: ElementDefinitionOptions) {
		if (!recorded.has(tag)) recorded.set(tag, cls);
		// Guard: happy-dom throws if a tag is defined twice in the same registry.
		if (!this.get(tag)) return origDefine.call(this, tag, cls, opts);
		return undefined;
	};
	proto.__bobbitDomBridge = true;
}

// Some app timers (e.g. render.ts's 2500ms header-toast timer, armed by a
// module-level `bobbit-launcher-feedback` listener) call `renderApp()` — which
// references the GLOBAL `requestAnimationFrame` — well after the test that armed
// them. happy-dom's per-window RAF is torn down between files, so such a
// straggler throws "requestAnimationFrame is not defined" as a run-failing
// unhandled error even though the render callback itself is a no-op in tests.
// Install a persistent setTimeout-backed fallback on globalThis so these
// harmless stragglers never crash the run. (No assertion depends on RAF timing;
// tests that need a real frame await it.)
// vitest's happy-dom environment defines window globals (incl.
// requestAnimationFrame) as OWN properties on globalThis at each file's setup and
// `delete`s them at teardown (populateGlobal). A straggler node timer (e.g. the
// app's debounced renderApp, armed by render.ts's 2500ms header-toast timer)
// firing in the teardown gap therefore hits an undefined bare
// `requestAnimationFrame` and crashes the run.
//
// We install NO-OP fallbacks on globalThis's PROTOTYPE (non-enumerable). During a
// live test the per-file OWN property (happy-dom's real rAF) shadows these and
// fires normally, so tests that await a frame work. The prototype fallback is
// only ever reached in the teardown gap — and there we deliberately DO NOTHING:
// running the stale render callback would `render()` into an already-removed
// container / touch a torn-down `document`, producing a different run-failing
// error. Dropping the gap-straggler frame is correct and side-effect-free.
function ensureAnimationFrame(): void {
	const gproto = Object.getPrototypeOf(globalThis as any);
	if (!gproto || (gproto as any).__bobbitFrameFallback) return;
	const def = (name: string, value: (arg: any) => any) =>
		Object.defineProperty(gproto, name, { value, configurable: true, writable: true, enumerable: false });
	def("requestAnimationFrame", (_cb: FrameRequestCallback) => 0);
	def("cancelAnimationFrame", (_id: any) => undefined);
	(gproto as any).__bobbitFrameFallback = true;
}
ensureAnimationFrame();

function defineAllInto(ce: CustomElementRegistry | undefined): void {
	if (!ce) return;
	for (const [tag, cls] of recorded) {
		if (!ce.get(tag)) ce.define(tag, cls);
	}
}

/**
 * Replay every recorded custom-element definition into (a) the current window's
 * registry and (b) lit-html's pinned document's registry. Idempotent; call it in
 * a top-level `beforeAll` at the top of every dom test file, AFTER the static
 * component imports so anything defined during those imports is present.
 */
export function syncCustomElements(): void {
	ensureAnimationFrame();
	defineAllInto((globalThis as any).customElements);
	if (litCustomElements && litCustomElements !== (globalThis as any).customElements) defineAllInto(litCustomElements);
	const dvCE = (litDocument as any)?.defaultView?.customElements;
	if (dvCE) defineAllInto(dvCE);
}
