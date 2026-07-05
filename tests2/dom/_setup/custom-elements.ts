// Shared custom-element registration bridge for the v2-dom (happy-dom) tier.
//
// WHY THIS EXISTS
// vitest runs with `pool:"forks", isolate:false` (see vitest.config.ts). Under
// that config the module registry is shared across all test files in a fork,
// but happy-dom hands each test file a BRAND-NEW window (fresh
// `customElements` registry). A component's `@customElement("x")` define is a
// module-eval side-effect that therefore runs exactly ONCE — against whichever
// file's window first imported (directly or transitively) that module. Every
// other file then gets a fresh registry with `x` missing, and its cached import
// never re-runs the define, so `document.createElement("x")` produces an inert,
// un-upgraded element and all DOM assertions fail.
//
// FIX
// Patch `CustomElementRegistry.prototype.define` (once per fork) to record every
// (tag -> class) definition into a module-global map that survives across files.
// Each test file calls `syncCustomElements()` at module-eval time (after its own
// imports) to replay every recorded definition into the current window's fresh
// registry. Because the patch is on the PROTOTYPE, it captures defines from ALL
// windows — including lazy/transitive elements defined mid-test — so replay is
// complete regardless of which file first imported a component.
//
// This keeps a SINGLE lit copy (no `vi.resetModules()` / cache-busting dynamic
// imports, which spawn a second lit realm and cause "createRenderRoot is not a
// function" cross-realm failures). Import this module FIRST in every dom test.

type CE = CustomElementConstructor;

const recorded = new Map<string, CE>();

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

/**
 * Replay every recorded custom-element definition into the current window's
 * registry. Idempotent and safe to call at the top of every test file. Call it
 * AFTER static component imports so anything defined during those imports (in
 * this or a prior file) is present in this file's fresh window.
 */
export function syncCustomElements(): void {
	const ce: CustomElementRegistry | undefined = (globalThis as any).customElements;
	if (!ce) return;
	for (const [tag, cls] of recorded) {
		if (!ce.get(tag)) ce.define(tag, cls);
	}
}
