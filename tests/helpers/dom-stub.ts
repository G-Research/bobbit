/**
 * Tiny DOM stub for Node test-runner contexts that import UI modules.
 *
 * mini-lit's `icon()` helper calls `document.createElementNS(...).outerHTML`
 * (via `lucide`'s `createElement`) to embed inline SVG. The Node test
 * runner has no DOM, so we stub the minimum surface those callers need.
 *
 * Import this module BEFORE any UI renderer module. The stub is installed
 * as a side-effect of importing, so place this at the very top of the
 * import list. Re-importing is a no-op.
 */

if (typeof (globalThis as any).document === "undefined") {
	type FakeEl = {
		tagName: string;
		attrs: Record<string, string>;
		children: FakeEl[];
		setAttribute(k: string, v: string): void;
		appendChild(c: FakeEl): FakeEl;
		readonly outerHTML: string;
	};
	const makeEl = (tag: string): FakeEl => {
		const el = {
			tagName: tag,
			attrs: {} as Record<string, string>,
			children: [] as FakeEl[],
			setAttribute(k: string, v: string) { el.attrs[k] = v; },
			appendChild(c: FakeEl) { el.children.push(c); return c; },
			get outerHTML(): string {
				const attrs = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
				const inner = el.children.map(c => c.outerHTML).join("");
				return `<${el.tagName}${attrs}>${inner}</${el.tagName}>`;
			},
		};
		return el;
	};
	const walkerStub = {
		currentNode: null,
		nextNode: () => null,
		firstChild: () => null,
		nextSibling: () => null,
	};
	(globalThis as any).document = {
		createElementNS: (_ns: string, tag: string) => makeEl(tag),
		createElement: (tag: string) => makeEl(tag),
		createTreeWalker: () => walkerStub,
		createDocumentFragment: () => makeEl("#fragment"),
		dispatchEvent: () => true,
	};
	if (typeof (globalThis as any).HTMLElement === "undefined") {
		(globalThis as any).HTMLElement = class {} as any;
	}
	if (typeof (globalThis as any).customElements === "undefined") {
		(globalThis as any).customElements = {
			define: () => {},
			get: () => undefined,
			whenDefined: () => Promise.resolve(),
		};
	}
}
