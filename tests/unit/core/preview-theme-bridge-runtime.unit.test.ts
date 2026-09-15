import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
	PREVIEW_INITIAL_THEME_GLOBAL,
	PREVIEW_THEME_BRIDGE,
	type PreviewHostMessage,
} from "../../../src/shared/preview-bridge-scripts.js";

function bridgeProgram(): string {
	const match = PREVIEW_THEME_BRIDGE.match(/^<script(?:\s[^>]*)?>([\s\S]*)<\/script>$/i);
	if (!match) throw new Error("canonical preview theme bridge is not one script element");
	return match[1];
}

class RootStub {
	private readonly classes = new Set<string>();
	private readonly attributes = new Map<string, string>();
	readonly properties = new Map<string, string>();
	readonly scrollHeight = 120;
	readonly style = {
		fontFamily: "",
		setProperty: (name: string, value: string) => this.properties.set(name, value),
		removeProperty: (name: string) => this.properties.delete(name),
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

	setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
	getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
	removeAttribute(name: string): void { this.attributes.delete(name); }
}

const INITIAL_THEME: PreviewHostMessage = {
	type: "bobbit-preview-theme",
	version: 1,
	dark: true,
	palette: "violet",
	fontFamily: "Inter, system-ui",
	properties: {
		"--background": "initial-surface",
		"--foreground": "initial-foreground",
		"--card": "initial-card",
		"--positive": "initial-positive",
		"--chart-1": "initial-chart",
	},
};

function bridgeHarness(initial: unknown = INITIAL_THEME) {
	const childRoot = new RootStub();
	const parentMessages: unknown[] = [];
	const parent = { postMessage: (message: unknown) => parentMessages.push(message) };
	let messageListener: ((event: { source: unknown; data: unknown }) => void) | undefined;
	const resizeObservers: Array<{ callback: () => void; targets: unknown[] }> = [];
	class ResizeObserverStub {
		readonly record: { callback: () => void; targets: unknown[] };
		constructor(callback: () => void) {
			this.record = { callback, targets: [] };
			resizeObservers.push(this.record);
		}
		observe(target: unknown): void { this.record.targets.push(target); }
		disconnect(): void {}
	}
	const sandbox: Record<string, any> = {
		document: {
			documentElement: childRoot,
			body: { scrollHeight: 180 },
			readyState: "complete",
			addEventListener: () => {},
		},
		parent,
		ResizeObserver: ResizeObserverStub,
		addEventListener: (type: string, listener: typeof messageListener) => {
			if (type === "message") messageListener = listener;
		},
		[PREVIEW_INITIAL_THEME_GLOBAL]: initial,
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	return {
		context: vm.createContext(sandbox), childRoot, parent, parentMessages,
		resizeObservers, dispatch: (source: unknown, data: unknown) => messageListener?.({ source, data }),
	};
}

function runBridgeThenAuthored(context: vm.Context): void {
	vm.runInContext(`${bridgeProgram()}\n;globalThis.__authoredRuns = (globalThis.__authoredRuns || 0) + 1;`, context);
}

describe("canonical preview theme bridge runtime", () => {
	it("applies the initial DTO before authored code and requests one exact live channel", () => {
		const harness = bridgeHarness();
		runBridgeThenAuthored(harness.context);
		runBridgeThenAuthored(harness.context);

		expect(harness.childRoot.classList.contains("dark")).toBe(true);
		expect(harness.childRoot.getAttribute("data-palette")).toBe("violet");
		expect(harness.childRoot.style.fontFamily).toBe("Inter, system-ui");
		for (const [token, value] of Object.entries(INITIAL_THEME.properties)) {
			expect(harness.childRoot.style.getPropertyValue(token), token).toBe(value);
		}
		expect(harness.parentMessages).toContainEqual({ type: "bobbit-preview-ready", version: 1 });
		expect(harness.parentMessages).toContainEqual({ type: "bobbit-preview-resize", version: 1, height: 196 });
		expect(harness.resizeObservers).toHaveLength(1);
		expect(vm.runInContext("globalThis.__authoredRuns", harness.context)).toBe(2);
	});

	it("accepts only strict bounded theme messages from the exact parent", () => {
		const harness = bridgeHarness();
		runBridgeThenAuthored(harness.context);
		const live: PreviewHostMessage = {
			type: "bobbit-preview-theme",
			version: 1,
			dark: false,
			fontFamily: "system-ui",
			properties: { "--background": "live-surface" },
		};

		harness.dispatch({}, live);
		expect(harness.childRoot.style.getPropertyValue("--background")).toBe("initial-surface");
		harness.dispatch(harness.parent, { ...live, extra: true });
		harness.dispatch(harness.parent, { ...live, properties: { "--not-allowed": "value" } });
		harness.dispatch(harness.parent, { ...live, palette: "x".repeat(65) });
		expect(harness.childRoot.style.getPropertyValue("--background")).toBe("initial-surface");

		harness.dispatch(harness.parent, live);
		expect(harness.childRoot.classList.contains("dark")).toBe(false);
		expect(harness.childRoot.getAttribute("data-palette")).toBeNull();
		expect(harness.childRoot.style.fontFamily).toBe("system-ui");
		expect(harness.childRoot.style.getPropertyValue("--background")).toBe("live-surface");
		expect(harness.childRoot.style.getPropertyValue("--foreground")).toBe("");
		expect(vm.runInContext("globalThis.__authoredRuns", harness.context)).toBe(1);
	});

	it("fails cosmetically while subsequent authored code still runs", () => {
		for (const initial of [null, { ...INITIAL_THEME, version: 2 }, { ...INITIAL_THEME, properties: null }]) {
			const harness = bridgeHarness(initial);
			expect(() => runBridgeThenAuthored(harness.context)).not.toThrow();
			expect(vm.runInContext("globalThis.__authoredRuns", harness.context)).toBe(1);
		}
	});
});
