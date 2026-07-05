/**
 * Minimal DOM globals for v2-core (node env) tests that import lit-html
 * transitively. lit-html calls `document.createTreeWalker` / `createElement`
 * at MODULE INIT, so any module that imports it must have these globals defined
 * before the import runs. Because static imports hoist, callers must set the
 * stub first and then DYNAMICALLY import the module under test.
 *
 * `installLitDomStub()` FORCE-sets a complete stub (never `??=`) so a partial
 * document leaked by an earlier file in the shared fork (pool:"forks",
 * isolate:false) cannot shadow it — the root cause of an order-dependent
 * `d.createTreeWalker is not a function` flake. It is idempotent and permissive
 * (a complete stub leaking forward never breaks a later consumer).
 */
const treeWalkerStub = { nextNode: () => null, currentNode: null as unknown, firstChild: () => null, nextSibling: () => null };
const createElementStub = (): unknown => ({
	content: { firstChild: null, appendChild: () => {}, childNodes: [] },
	innerHTML: "",
	appendChild: () => {},
	setAttribute: () => {},
	style: { setProperty: () => {} },
});

export function installLitDomStub(): void {
	const g = globalThis as Record<string, unknown>;
	g.document = {
		documentElement: { dataset: {}, style: { setProperty: () => {} } },
		createTreeWalker: () => treeWalkerStub,
		createElement: createElementStub,
		createElementNS: createElementStub,
		createDocumentFragment: () => ({ appendChild: () => {}, childNodes: [] }),
		createTextNode: (t: string) => ({ data: t, nodeValue: t }),
		createComment: () => ({}),
		addEventListener: () => {},
		dispatchEvent: () => {},
	};
	g.window = g.window ?? { location: { origin: "http://localhost" }, addEventListener: () => {}, removeEventListener: () => {} };
}
