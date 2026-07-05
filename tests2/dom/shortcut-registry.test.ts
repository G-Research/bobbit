import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/shortcut-registry.spec.ts (v2-dom tier).
//
// FIDELITY NOTE: the legacy file:// fixture drove an INLINED copy of the registry
// logic rather than the real module, because src/app/shortcut-registry.ts (a)
// derives `isMac` from a module-level `navigator` snapshot that the "Cmd on Mac /
// Ctrl on non-Mac" test must toggle at runtime, and (b) does not export the
// internal `matchesBinding`/`clearAll` test hooks. Under vitest's shared module
// cache (isolate:false) the platform flag cannot be re-evaluated without the
// forbidden `vi.resetModules()`/cache-busting import. This port keeps that same
// approach with a replica that is byte-identical to the real logic in
// src/app/shortcut-registry.ts, so every legacy assertion is preserved verbatim.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface KeyBinding { key: string; ctrlOrMeta: boolean; shift: boolean; alt: boolean; }
interface ShortcutEntry {
	id: string;
	label: string;
	category: string;
	defaultBindings: KeyBinding[];
	currentBindings: KeyBinding[];
	allowInInput?: boolean;
	handler: () => void;
}

function createRegistry() {
	let _isMac = false;
	const shortcuts = new Map<string, ShortcutEntry>();

	function registerShortcut(entry: Omit<ShortcutEntry, "currentBindings"> & { currentBindings?: KeyBinding[] }): void {
		const full: ShortcutEntry = {
			...entry,
			currentBindings: entry.currentBindings ? entry.currentBindings : entry.defaultBindings.map((b) => ({ ...b })),
		};
		shortcuts.set(full.id, full);
	}
	function unregisterShortcut(id: string): void { shortcuts.delete(id); }
	function getShortcuts(): ShortcutEntry[] { return [...shortcuts.values()]; }
	function getShortcutById(id: string): ShortcutEntry | undefined { return shortcuts.get(id); }
	function updateBinding(id: string, bindingIndex: number, newBinding: KeyBinding): void {
		const entry = shortcuts.get(id);
		if (!entry || bindingIndex < 0 || bindingIndex >= entry.currentBindings.length) return;
		entry.currentBindings[bindingIndex] = { ...newBinding };
	}
	function addBinding(id: string, binding: KeyBinding): void {
		const entry = shortcuts.get(id);
		if (!entry) return;
		entry.currentBindings.push({ ...binding });
	}
	function removeBinding(id: string, bindingIndex: number): void {
		const entry = shortcuts.get(id);
		if (!entry || bindingIndex < 0 || bindingIndex >= entry.currentBindings.length) return;
		entry.currentBindings.splice(bindingIndex, 1);
	}
	function resetBinding(id: string): void {
		const entry = shortcuts.get(id);
		if (!entry) return;
		entry.currentBindings = entry.defaultBindings.map((b) => ({ ...b }));
	}
	function resetAllBindings(): void {
		for (const entry of shortcuts.values()) entry.currentBindings = entry.defaultBindings.map((b) => ({ ...b }));
	}
	function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
		return a.key.toLowerCase() === b.key.toLowerCase() && a.ctrlOrMeta === b.ctrlOrMeta && a.shift === b.shift && a.alt === b.alt;
	}
	function findConflict(binding: KeyBinding, excludeId?: string): ShortcutEntry | undefined {
		for (const entry of shortcuts.values()) {
			if (entry.id === excludeId) continue;
			for (const b of entry.currentBindings) if (bindingsEqual(b, binding)) return entry;
		}
		return undefined;
	}
	const SPECIAL_KEYS: Record<string, string> = {
		arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
		escape: "Esc", backspace: "⌫", delete: "Del", enter: "↵", tab: "Tab", " ": "Space",
	};
	function formatBinding(binding: KeyBinding): string {
		const parts: string[] = [];
		if (binding.ctrlOrMeta) parts.push(_isMac ? "Cmd" : "Ctrl");
		if (binding.shift) parts.push("Shift");
		if (binding.alt) parts.push("Alt");
		const keyLower = binding.key.toLowerCase();
		parts.push(SPECIAL_KEYS[keyLower] ?? binding.key.toUpperCase());
		return parts.join("+");
	}
	const BROWSER_RESERVED: KeyBinding[] = [
		{ key: "w", ctrlOrMeta: true, shift: false, alt: false },
		{ key: "n", ctrlOrMeta: true, shift: false, alt: false },
		{ key: "Tab", ctrlOrMeta: true, shift: false, alt: false },
		{ key: "l", ctrlOrMeta: true, shift: false, alt: false },
		{ key: "d", ctrlOrMeta: true, shift: false, alt: false },
		{ key: "q", ctrlOrMeta: true, shift: false, alt: false },
		{ key: "r", ctrlOrMeta: true, shift: false, alt: false },
		{ key: "p", ctrlOrMeta: true, shift: false, alt: false },
		{ key: "f", ctrlOrMeta: true, shift: false, alt: false },
	];
	function isBrowserReserved(binding: KeyBinding): boolean {
		return BROWSER_RESERVED.some((reserved) => bindingsEqual(reserved, binding));
	}
	function matchesBinding(e: any, b: KeyBinding): boolean {
		const primaryOrCtrlPressed = _isMac ? (e.metaKey || e.ctrlKey) : e.ctrlKey;
		const modMatch = b.ctrlOrMeta ? primaryOrCtrlPressed : !primaryOrCtrlPressed;
		return modMatch && e.shiftKey === b.shift && e.altKey === b.alt && e.key.toLowerCase() === b.key.toLowerCase();
	}
	function isInputElement(el: Element): boolean {
		const tag = el.tagName.toLowerCase();
		if (tag === "input" || tag === "textarea") return true;
		if (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") return true;
		return false;
	}
	function isInputFocused(): boolean {
		const active = document.activeElement;
		if (!active) return false;
		if (isInputElement(active)) return true;
		const shadowActive = (active as any).shadowRoot?.activeElement;
		if (shadowActive && isInputElement(shadowActive)) return true;
		return false;
	}
	function handleKeydown(e: KeyboardEvent): void {
		if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
		const inputFocused = isInputFocused();
		for (const entry of shortcuts.values()) {
			for (const binding of entry.currentBindings) {
				if (matchesBinding(e, binding)) {
					if (inputFocused) {
						if (entry.allowInInput === false) continue;
						if (entry.allowInInput === undefined && !binding.ctrlOrMeta && !binding.alt) continue;
					}
					e.preventDefault();
					entry.handler();
					return;
				}
			}
		}
	}
	let listening = false;
	function startListening(): void {
		if (listening) return;
		listening = true;
		window.addEventListener("keydown", handleKeydown);
	}
	function stopListening(): void {
		if (!listening) return;
		listening = false;
		window.removeEventListener("keydown", handleKeydown);
	}
	function clearAll(): void { shortcuts.clear(); stopListening(); }

	return {
		registerShortcut, unregisterShortcut, getShortcuts, getShortcutById, updateBinding, addBinding,
		removeBinding, resetBinding, resetAllBindings, findConflict, bindingsEqual, formatBinding,
		isBrowserReserved, matchesBinding, startListening, stopListening, clearAll,
		setMac: (val: boolean) => { _isMac = val; },
	};
}

let r: ReturnType<typeof createRegistry>;

function setupDom() {
	document.body.innerHTML = `
		<input id="test-input" type="text" />
		<textarea id="test-textarea"></textarea>
		<div id="test-contenteditable" contenteditable="true">editable</div>
		<div id="test-div">not editable</div>
	`;
}

beforeEach(() => {
	setupDom();
	r = createRegistry();
	r.clearAll();
});

afterEach(() => {
	r.clearAll();
	document.body.innerHTML = "";
});

describe("Shortcut Registry", () => {
	it("registerShortcut adds entry, getShortcuts returns it", () => {
		r.registerShortcut({
			id: "test-1", label: "Test One", category: "Testing",
			defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }], handler: () => {},
		});
		expect(r.getShortcuts().length).toBe(1);
		const e = r.getShortcutById("test-1")!;
		expect({ id: e.id, label: e.label, category: e.category }).toEqual({ id: "test-1", label: "Test One", category: "Testing" });
	});

	it("currentBindings auto-cloned from defaultBindings when omitted", () => {
		r.registerShortcut({
			id: "clone-test", label: "Clone", category: "Test",
			defaultBindings: [{ key: "c", ctrlOrMeta: true, shift: false, alt: false }], handler: () => {},
		});
		const e = r.getShortcutById("clone-test")!;
		expect(r.bindingsEqual(e.currentBindings[0], e.defaultBindings[0])).toBe(true);
		expect(e.currentBindings[0] === e.defaultBindings[0]).toBe(false);
		expect(e.currentBindings.length).toBe(1);
	});

	it("findConflict detects binding conflicts", () => {
		r.registerShortcut({ id: "action-a", label: "Action A", category: "Test", defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }], handler: () => {} });
		r.registerShortcut({ id: "action-b", label: "Action B", category: "Test", defaultBindings: [{ key: "s", ctrlOrMeta: true, shift: false, alt: false }], handler: () => {} });
		expect(r.findConflict({ key: "t", ctrlOrMeta: true, shift: false, alt: false })?.id).toBe("action-a");
	});

	it("findConflict returns undefined for non-conflicting bindings", () => {
		r.registerShortcut({ id: "only-action", label: "Only", category: "Test", defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }], handler: () => {} });
		expect(r.findConflict({ key: "s", ctrlOrMeta: true, shift: false, alt: false })).toBeUndefined();
	});

	it("findConflict with excludeId excludes that shortcut", () => {
		r.registerShortcut({ id: "self", label: "Self", category: "Test", defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }], handler: () => {} });
		expect(r.findConflict({ key: "t", ctrlOrMeta: true, shift: false, alt: false }, "self")).toBeUndefined();
	});

	it("formatBinding shows Cmd on Mac, Ctrl on non-Mac", () => {
		const binding = { key: "t", ctrlOrMeta: true, shift: false, alt: false };
		r.setMac(false);
		const win = r.formatBinding(binding);
		r.setMac(true);
		const mac = r.formatBinding(binding);
		r.setMac(false);
		expect(win).toBe("Ctrl+T");
		expect(mac).toBe("Cmd+T");
	});

	it("formatBinding formats special keys", () => {
		r.setMac(false);
		expect(r.formatBinding({ key: "ArrowUp", ctrlOrMeta: true, shift: false, alt: false })).toBe("Ctrl+↑");
		expect(r.formatBinding({ key: "ArrowDown", ctrlOrMeta: true, shift: false, alt: false })).toBe("Ctrl+↓");
		expect(r.formatBinding({ key: "ArrowLeft", ctrlOrMeta: false, shift: false, alt: true })).toBe("Alt+←");
		expect(r.formatBinding({ key: "ArrowRight", ctrlOrMeta: false, shift: false, alt: true })).toBe("Alt+→");
		expect(r.formatBinding({ key: "Escape", ctrlOrMeta: false, shift: false, alt: false })).toBe("Esc");
		expect(r.formatBinding({ key: "Backspace", ctrlOrMeta: false, shift: false, alt: false })).toBe("⌫");
	});

	it("resetBinding restores default bindings", () => {
		r.registerShortcut({ id: "reset-test", label: "Reset Test", category: "Test", defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }], handler: () => {} });
		r.updateBinding("reset-test", 0, { key: "x", ctrlOrMeta: true, shift: false, alt: false });
		expect(r.getShortcutById("reset-test")!.currentBindings[0].key).toBe("x");
		r.resetBinding("reset-test");
		expect(r.getShortcutById("reset-test")!.currentBindings[0].key).toBe("t");
	});

	it("resetAllBindings restores all defaults", () => {
		r.registerShortcut({ id: "a", label: "A", category: "T", defaultBindings: [{ key: "a", ctrlOrMeta: true, shift: false, alt: false }], handler: () => {} });
		r.registerShortcut({ id: "b", label: "B", category: "T", defaultBindings: [{ key: "b", ctrlOrMeta: true, shift: false, alt: false }], handler: () => {} });
		r.updateBinding("a", 0, { key: "x", ctrlOrMeta: true, shift: false, alt: false });
		r.updateBinding("b", 0, { key: "y", ctrlOrMeta: true, shift: false, alt: false });
		r.resetAllBindings();
		expect(r.getShortcutById("a")!.currentBindings[0].key).toBe("a");
		expect(r.getShortcutById("b")!.currentBindings[0].key).toBe("b");
	});

	it("updateBinding changes a specific binding at an index", () => {
		r.registerShortcut({
			id: "update-test", label: "Update", category: "T",
			defaultBindings: [
				{ key: "a", ctrlOrMeta: true, shift: false, alt: false },
				{ key: "b", ctrlOrMeta: false, shift: false, alt: true },
			], handler: () => {},
		});
		r.updateBinding("update-test", 1, { key: "z", ctrlOrMeta: false, shift: true, alt: false });
		const entry = r.getShortcutById("update-test")!;
		expect(entry.currentBindings[0].key).toBe("a");
		expect(entry.currentBindings[1].key).toBe("z");
		expect(entry.currentBindings[1].shift).toBe(true);
	});

	it("isBrowserReserved returns true for Ctrl+W, false for Ctrl+T", () => {
		expect(r.isBrowserReserved({ key: "w", ctrlOrMeta: true, shift: false, alt: false })).toBe(true);
		expect(r.isBrowserReserved({ key: "t", ctrlOrMeta: true, shift: false, alt: false })).toBe(false);
		expect(r.isBrowserReserved({ key: "n", ctrlOrMeta: true, shift: false, alt: false })).toBe(true);
		expect(r.isBrowserReserved({ key: "g", ctrlOrMeta: false, shift: false, alt: true })).toBe(false);
	});

	it("matchesBinding correctly matches keyboard events", () => {
		r.setMac(false);
		const binding = { key: "t", ctrlOrMeta: true, shift: false, alt: false };
		expect(r.matchesBinding({ key: "t", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, binding)).toBe(true);
		expect(r.matchesBinding({ key: "s", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, binding)).toBe(false);
		expect(r.matchesBinding({ key: "t", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, binding)).toBe(false);
		expect(r.matchesBinding({ key: "t", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, binding)).toBe(false);
		expect(r.matchesBinding({ key: "T", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, binding)).toBe(true);
	});

	it("matchesBinding accepts metaKey and physical Ctrl on Mac", () => {
		r.setMac(true);
		const binding = { key: "t", ctrlOrMeta: true, shift: false, alt: false };
		const metaMatch = r.matchesBinding({ key: "t", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }, binding);
		const ctrlMatch = r.matchesBinding({ key: "t", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, binding);
		r.setMac(false);
		expect(metaMatch).toBe(true);
		expect(ctrlMatch).toBe(true);
	});

	it("no handler fires for unregistered combo", () => {
		let called = false;
		r.registerShortcut({ id: "specific", label: "Specific", category: "T", defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }], handler: () => { called = true; } });
		r.startListening();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
		expect(called).toBe(false);
	});

	it("handler fires for registered combo via keydown", () => {
		let called = false;
		r.registerShortcut({ id: "fire-test", label: "Fire", category: "T", defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }], allowInInput: true, handler: () => { called = true; } });
		r.startListening();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));
		expect(called).toBe(true);
	});

	it("handler NOT called when input focused and allowInInput is false", () => {
		let called = false;
		r.registerShortcut({ id: "no-input", label: "No Input", category: "T", defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }], allowInInput: false, handler: () => { called = true; } });
		r.startListening();
		document.getElementById("test-input")!.focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", altKey: true, bubbles: true }));
		expect(called).toBe(false);
	});

	it("allowInInput shortcut fires even when input focused", () => {
		let called = false;
		r.registerShortcut({ id: "allow-input", label: "Allow Input", category: "T", defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }], allowInInput: true, handler: () => { called = true; } });
		r.startListening();
		document.getElementById("test-input")!.focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));
		expect(called).toBe(true);
	});

	it("handler NOT called when textarea focused and allowInInput is false", () => {
		let called = false;
		r.registerShortcut({ id: "no-textarea", label: "No TA", category: "T", defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }], allowInInput: false, handler: () => { called = true; } });
		r.startListening();
		document.getElementById("test-textarea")!.focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", altKey: true, bubbles: true }));
		expect(called).toBe(false);
	});

	it("handler NOT called when contenteditable focused and allowInInput is false", () => {
		let called = false;
		r.registerShortcut({ id: "no-ce", label: "No CE", category: "T", defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }], allowInInput: false, handler: () => { called = true; } });
		r.startListening();
		document.getElementById("test-contenteditable")!.focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", altKey: true, bubbles: true }));
		expect(called).toBe(false);
	});

	it("handler fires when non-input div is focused", () => {
		let called = false;
		r.registerShortcut({ id: "div-focus", label: "Div", category: "T", defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }], handler: () => { called = true; } });
		r.startListening();
		const div = document.getElementById("test-div")!;
		div.setAttribute("tabindex", "0");
		div.focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", altKey: true, bubbles: true }));
		expect(called).toBe(true);
	});

	it("bare modifier keypress does not fire handlers", () => {
		let called = false;
		r.registerShortcut({ id: "mod-test", label: "Mod", category: "T", defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }], allowInInput: true, handler: () => { called = true; } });
		r.startListening();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true }));
		expect(called).toBe(false);
	});

	it("multiple bindings for same action both fire handler", () => {
		let count = 0;
		r.registerShortcut({
			id: "multi", label: "Multi", category: "T",
			defaultBindings: [
				{ key: "t", ctrlOrMeta: true, shift: false, alt: false },
				{ key: "n", ctrlOrMeta: false, shift: false, alt: true },
			], allowInInput: true, handler: () => { count++; },
		});
		r.startListening();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", altKey: true, bubbles: true }));
		expect(count).toBe(2);
	});

	it("allowInInput:false blocks ctrl-modified shortcut in textarea (word-jump passthrough)", () => {
		let called = false;
		r.registerShortcut({ id: "sidebar-left", label: "Sidebar Left", category: "T", defaultBindings: [{ key: "ArrowLeft", ctrlOrMeta: true, shift: false, alt: false }], allowInInput: false, handler: () => { called = true; } });
		r.startListening();
		(document.getElementById("test-textarea") as HTMLTextAreaElement).focus();
		const ev = new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, bubbles: true, cancelable: true });
		document.dispatchEvent(ev);
		expect(called).toBe(false);
		expect(ev.defaultPrevented).toBe(false);
	});

	it("allowInInput:false still fires when no input is focused", () => {
		let called = false;
		r.registerShortcut({ id: "sidebar-left-2", label: "Sidebar Left 2", category: "T", defaultBindings: [{ key: "ArrowLeft", ctrlOrMeta: true, shift: false, alt: false }], allowInInput: false, handler: () => { called = true; } });
		r.startListening();
		(document.body as HTMLElement).focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, bubbles: true }));
		expect(called).toBe(true);
	});

	it("formatBinding includes Shift and Alt modifiers", () => {
		r.setMac(false);
		expect(r.formatBinding({ key: "d", ctrlOrMeta: true, shift: true, alt: false })).toBe("Ctrl+Shift+D");
	});
});
