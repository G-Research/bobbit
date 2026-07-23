import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { PREVIEW_THEME_BRIDGE } from "../../src/shared/preview-bridge-scripts.js";

function bridgeProgram(): string {
	const match = PREVIEW_THEME_BRIDGE.match(/^<script(?:\s[^>]*)?>([\s\S]*)<\/script>$/i);
	if (!match) throw new Error("canonical preview theme bridge is not one script element");
	return match[1];
}

class RootStub {
	private readonly classes = new Set<string>();
	private readonly attributes = new Map<string, string>();
	readonly properties = new Map<string, string>();
	readonly style = {
		fontFamily: "",
		setProperty: (name: string, value: string) => this.properties.set(name, value),
		getPropertyValue: (name: string) => this.properties.get(name) ?? "",
	};
	readonly classList = {
		contains: (name: string) => this.classes.has(name),
		toggle: (name: string, enabled?: boolean) => {
			const next = enabled ?? !this.classes.has(name);
			if (next) this.classes.add(name);
			else this.classes.delete(name);
			return next;
		},
	};

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
}

function declaration(...names: string[]): Record<string | number, unknown> {
	const style: Record<string | number, unknown> = { length: names.length };
	for (let index = 0; index < names.length; index++) style[index] = names[index];
	return style;
}

interface ObserverRecord {
	callback: () => void;
	target?: unknown;
	options?: unknown;
}

function normalBridgeHarness() {
	const childRoot = new RootStub();
	const parentRoot = new RootStub();
	parentRoot.classList.toggle("dark", true);
	parentRoot.setAttribute("data-palette", "violet");

	const values: Record<string, string> = {
		"--background": "oklch(0.18 0.01 280)",
		"--foreground": "oklch(0.96 0.01 280)",
		"--card": "oklch(0.22 0.01 280)",
		"--positive": "oklch(0.72 0.18 145)",
		"--chart-1": "oklch(0.68 0.20 305)",
	};
	const inaccessibleSheet = {
		get cssRules(): never {
			throw new Error("SecurityError: cross-origin stylesheet");
		},
	};
	const styleSheets = [
		inaccessibleSheet,
		{ cssRules: [{ style: declaration("--background", "--foreground", "--card") }] },
		{ cssRules: [{ style: declaration("--positive", "--chart-1", "--background") }] },
	];
	const parentDocument = { documentElement: parentRoot, styleSheets };
	const parent = {
		document: parentDocument,
		getComputedStyle: () => ({
			fontFamily: 'Inter, ui-sans-serif, system-ui',
			getPropertyValue: (name: string) => values[name] ?? "",
		}),
	};
	const observers: ObserverRecord[] = [];
	class MutationObserverStub {
		private readonly record: ObserverRecord;
		constructor(callback: () => void) {
			this.record = { callback };
			observers.push(this.record);
		}
		observe(target: unknown, options: unknown): void {
			this.record.target = target;
			this.record.options = options;
		}
	}

	const sandbox: Record<string, unknown> = {
		document: { documentElement: childRoot },
		parent,
		MutationObserver: MutationObserverStub,
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	return {
		context: vm.createContext(sandbox),
		childRoot,
		parentRoot,
		values,
		observers,
	};
}

function runBridgeThenAuthored(context: vm.Context): void {
	vm.runInContext(`${bridgeProgram()}\n;globalThis.__authoredRuns = (globalThis.__authoredRuns || 0) + 1;`, context);
}

describe("canonical preview theme bridge runtime", () => {
	it("mirrors representative tokens and live host state once even when installed twice", () => {
		const harness = normalBridgeHarness();

		runBridgeThenAuthored(harness.context);
		runBridgeThenAuthored(harness.context);

		expect(harness.childRoot.classList.contains("dark")).toBe(true);
		expect(harness.childRoot.getAttribute("data-palette")).toBe("violet");
		expect(harness.childRoot.style.fontFamily).toBe("Inter, ui-sans-serif, system-ui");
		for (const [token, value] of Object.entries(harness.values)) {
			expect(harness.childRoot.style.getPropertyValue(token), token).toBe(value);
		}
		expect(harness.observers).toHaveLength(1);
		expect(harness.observers[0].target).toBe(harness.parentRoot);
		expect(harness.observers[0].options).toEqual({
			attributes: true,
			attributeFilter: ["class", "data-palette", "style"],
		});
		expect(vm.runInContext("globalThis.__authoredRuns", harness.context)).toBe(2);

		harness.parentRoot.classList.toggle("dark", false);
		harness.parentRoot.removeAttribute("data-palette");
		harness.values["--background"] = "oklch(0.98 0.01 280)";
		harness.observers[0].callback();

		expect(harness.childRoot.classList.contains("dark")).toBe(false);
		expect(harness.childRoot.getAttribute("data-palette")).toBeNull();
		expect(harness.childRoot.style.getPropertyValue("--background")).toBe("oklch(0.98 0.01 280)");
	});

	it("fails open while subsequent authored code runs when parent access or browser seams are unavailable", () => {
		const cases: Array<{ name: string; makeSandbox: () => Record<string, unknown> }> = [
			{
				name: "standalone parent",
				makeSandbox: () => {
					const sandbox: Record<string, unknown> = {
						document: { documentElement: new RootStub() },
						MutationObserver: class {},
					};
					sandbox.window = sandbox;
					sandbox.parent = sandbox;
					sandbox.globalThis = sandbox;
					return sandbox;
				},
			},
			{
				name: "inaccessible parent document",
				makeSandbox: () => {
					const parent = Object.create(null, {
						document: { get: () => { throw new Error("SecurityError"); } },
					});
					return { document: { documentElement: new RootStub() }, parent, MutationObserver: class {} };
				},
			},
			{
				name: "unavailable computed style",
				makeSandbox: () => ({
					document: { documentElement: new RootStub() },
					parent: {
						document: { documentElement: new RootStub(), styleSheets: [] },
						getComputedStyle: () => { throw new Error("not available"); },
					},
					MutationObserver: class {},
				}),
			},
			{
				name: "inaccessible stylesheet collection",
				makeSandbox: () => {
					const parentRoot = new RootStub();
					const parentDocument = Object.create(null, {
						documentElement: { value: parentRoot },
						styleSheets: { get: () => { throw new Error("SecurityError"); } },
					});
					return {
						document: { documentElement: new RootStub() },
						parent: {
							document: parentDocument,
							getComputedStyle: () => ({ fontFamily: "system-ui", getPropertyValue: () => "" }),
						},
						MutationObserver: class { observe(): void {} },
					};
				},
			},
			{
				name: "unavailable observer",
				makeSandbox: () => ({
					document: { documentElement: new RootStub() },
					parent: {
						document: { documentElement: new RootStub(), styleSheets: [] },
						getComputedStyle: () => ({ fontFamily: "system-ui", getPropertyValue: () => "" }),
					},
					MutationObserver: undefined,
				}),
			},
		];

		for (const testCase of cases) {
			const sandbox = testCase.makeSandbox();
			sandbox.window ??= sandbox;
			sandbox.globalThis ??= sandbox;
			const context = vm.createContext(sandbox);
			expect(() => runBridgeThenAuthored(context), testCase.name).not.toThrow();
			expect(vm.runInContext("globalThis.__authoredRuns", context), testCase.name).toBe(1);
		}
	});
});
