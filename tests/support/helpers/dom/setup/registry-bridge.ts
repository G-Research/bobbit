// Registry/timer bridge internals for the v2-dom (happy-dom) tier.
//
// Split out from custom-elements.ts so the CustomElementRegistry patch installs
// BEFORE custom-elements.ts pre-imports real lazy components (markdown-block,
// gate-verification-live). Static imports in a module run in source order, so the
// entry module imports THIS first, then the components — guaranteeing their
// `@customElement` defines are recorded and mirrored into lit-html's pinned
// registry before any template that references them is ever parsed/cached.
//
// See custom-elements.ts for the full rationale of the isolate:false problems.
import "lit"; // pin lit-html's captured `document` to this (first) window

type CE = CustomElementConstructor;

const recorded = new Map<string, CE>();

// lit-html captured `document` at init === the current document/registry here,
// because this module is imported first in every file and the first-executed file
// triggers both evaluations in one window.
const litDocument: Document | undefined = (globalThis as any).document;
const litCustomElements: CustomElementRegistry | undefined = (globalThis as any).customElements;

const proto: any = (globalThis as any).CustomElementRegistry?.prototype;
if (proto && !proto.__bobbitDomBridge) {
	const origDefine: (tag: string, cls: CE, opts?: ElementDefinitionOptions) => void = proto.define;
	proto.define = function patchedDefine(tag: string, cls: CE, opts?: ElementDefinitionOptions) {
		if (!recorded.has(tag)) recorded.set(tag, cls);
		let result: any;
		// Guard: happy-dom throws if a tag is defined twice in the same registry.
		if (!this.get(tag)) result = origDefine.call(this, tag, cls, opts);
		// Immediately mirror into lit-html's PINNED registry so elements defined
		// LATE (lazy dynamic imports fired mid-test, after this file's beforeAll
		// sync) still upgrade when lit parses their templates in the pinned window.
		if (litCustomElements && litCustomElements !== this && !litCustomElements.get(tag)) {
			origDefine.call(litCustomElements, tag, cls, opts);
		}
		return result;
	};
	proto.__bobbitDomBridge = true;
}

// vitest's happy-dom environment defines window globals (incl.
// requestAnimationFrame) as OWN properties on globalThis at each file's setup and
// `delete`s them at teardown. A straggler node timer (e.g. the app's debounced
// renderApp, armed by render.ts's 2500ms header-toast timer) firing in the
// teardown gap therefore hits an undefined bare `requestAnimationFrame`.
//
// We install NO-OP fallbacks on globalThis's PROTOTYPE (non-enumerable). During a
// live test the per-file OWN property (happy-dom's real rAF) shadows these and
// fires normally. The prototype fallback is only ever reached in the teardown gap
// — and there we deliberately DO NOTHING: running the stale render callback would
// render() into a removed container / torn-down document. Dropping the
// gap-straggler frame is correct and side-effect-free.
function ensureGapGlobals(): void {
	const gproto = Object.getPrototypeOf(globalThis as any);
	if (!gproto || (gproto as any).__bobbitGapGlobals) return;
	const def = (name: string, value: any) =>
		Object.defineProperty(gproto, name, { value, configurable: true, writable: true, enumerable: false });
	// rAF is a populateGlobal own-property during live tests (shadows this), so this
	// fallback is only reached in the teardown gap. We still RUN the callback (in a
	// try/catch) rather than dropping it: the app's renderApp() closure sets the
	// module-global `_renderScheduled = true` BEFORE calling requestAnimationFrame,
	// and only the callback resets it. A dropped frame would leave `_renderScheduled`
	// stuck true (shared across files under isolate:false), so a later file's
	// renderApp() early-returns and its debounce assertions flake. Running the
	// callback resets the flag; the subsequent render-into-torn-down-container throw
	// is swallowed harmlessly. (document/localStorage are NOT safe to shadow on the
	// prototype — they leak into live tests — so api.ts poller stragglers are stopped
	// at the file level instead.)
	def("requestAnimationFrame", (cb: FrameRequestCallback) => { try { cb(Date.now()); } catch { /* stale gap render */ } return 0; });
	def("cancelAnimationFrame", (_id: any) => undefined);
	(gproto as any).__bobbitGapGlobals = true;
}
ensureGapGlobals();

function defineAllInto(ce: CustomElementRegistry | undefined): void {
	if (!ce) return;
	for (const [tag, cls] of recorded) {
		if (!ce.get(tag)) ce.define(tag, cls);
	}
}

/**
 * Replay every recorded custom-element definition into (a) the current window's
 * registry and (b) lit-html's pinned document's registry. Idempotent; call it in
 * a top-level `beforeAll` at the top of every dom test file.
 */
export function syncCustomElements(): void {
	ensureGapGlobals();
	defineAllInto((globalThis as any).customElements);
	if (litCustomElements && litCustomElements !== (globalThis as any).customElements) defineAllInto(litCustomElements);
	const dvCE = (litDocument as any)?.defaultView?.customElements;
	if (dvCE) defineAllInto(dvCE);
}
