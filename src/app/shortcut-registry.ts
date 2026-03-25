/**
 * Central keyboard shortcut registry.
 *
 * Replaces the hardcoded keydown listener in main.ts with a data-driven
 * registry that supports rebinding, persistence, and conflict detection.
 */

import { gatewayFetch } from "./api.js";

// ============================================================================
// TYPES
// ============================================================================

export interface KeyBinding {
	key: string;           // e.g. "t", "/", "[", "ArrowUp"
	ctrlOrMeta: boolean;   // true = Ctrl on Win/Linux, Cmd on Mac
	shift: boolean;
	alt: boolean;
}

export interface ShortcutEntry {
	id: string;
	label: string;
	category: string;
	defaultBindings: KeyBinding[];
	currentBindings: KeyBinding[];
	allowInInput?: boolean;
	handler: () => void;
}

// ============================================================================
// PLATFORM DETECTION
// ============================================================================

const isMac = typeof navigator !== "undefined"
	? /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
	: false;

// ============================================================================
// REGISTRY
// ============================================================================

const shortcuts: Map<string, ShortcutEntry> = new Map();

/**
 * Register a shortcut. If `currentBindings` is omitted, it is
 * auto-cloned from `defaultBindings`.
 */
export function registerShortcut(
	entry: Omit<ShortcutEntry, "currentBindings"> & { currentBindings?: KeyBinding[] },
): void {
	const full: ShortcutEntry = {
		...entry,
		currentBindings: entry.currentBindings
			? entry.currentBindings
			: entry.defaultBindings.map((b) => ({ ...b })),
	};
	shortcuts.set(full.id, full);
}

export function unregisterShortcut(id: string): void {
	shortcuts.delete(id);
}

export function getShortcuts(): ShortcutEntry[] {
	return [...shortcuts.values()];
}

export function getShortcutById(id: string): ShortcutEntry | undefined {
	return shortcuts.get(id);
}

export function updateBinding(id: string, bindingIndex: number, newBinding: KeyBinding): void {
	const entry = shortcuts.get(id);
	if (!entry || bindingIndex < 0 || bindingIndex >= entry.currentBindings.length) return;
	entry.currentBindings[bindingIndex] = { ...newBinding };
}

export function addBinding(id: string, binding: KeyBinding): void {
	const entry = shortcuts.get(id);
	if (!entry) return;
	entry.currentBindings.push({ ...binding });
}

export function removeBinding(id: string, bindingIndex: number): void {
	const entry = shortcuts.get(id);
	if (!entry || bindingIndex < 0 || bindingIndex >= entry.currentBindings.length) return;
	entry.currentBindings.splice(bindingIndex, 1);
}

export function resetBinding(id: string): void {
	const entry = shortcuts.get(id);
	if (!entry) return;
	entry.currentBindings = entry.defaultBindings.map((b) => ({ ...b }));
}

export function resetAllBindings(): void {
	for (const entry of shortcuts.values()) {
		entry.currentBindings = entry.defaultBindings.map((b) => ({ ...b }));
	}
}

/**
 * Find a shortcut that already uses the given binding.
 * Optionally exclude a shortcut ID (e.g. the one being rebound).
 */
export function findConflict(binding: KeyBinding, excludeId?: string): ShortcutEntry | undefined {
	for (const entry of shortcuts.values()) {
		if (entry.id === excludeId) continue;
		for (const b of entry.currentBindings) {
			if (bindingsEqual(b, binding)) return entry;
		}
	}
	return undefined;
}

export function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
	return (
		a.key.toLowerCase() === b.key.toLowerCase() &&
		a.ctrlOrMeta === b.ctrlOrMeta &&
		a.shift === b.shift &&
		a.alt === b.alt
	);
}

// ============================================================================
// FORMATTING
// ============================================================================

const SPECIAL_KEYS: Record<string, string> = {
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
	escape: "Esc",
	backspace: "⌫",
	delete: "Del",
	enter: "↵",
	tab: "Tab",
	" ": "Space",
};

export function formatBinding(binding: KeyBinding): string {
	const parts: string[] = [];
	if (binding.ctrlOrMeta) parts.push(isMac ? "Cmd" : "Ctrl");
	if (binding.shift) parts.push("Shift");
	if (binding.alt) parts.push("Alt");

	const keyLower = binding.key.toLowerCase();
	const keyDisplay = SPECIAL_KEYS[keyLower] ?? binding.key.toUpperCase();
	parts.push(keyDisplay);

	return parts.join("+");
}

// ============================================================================
// BROWSER-RESERVED COMBOS
// ============================================================================

const BROWSER_RESERVED: KeyBinding[] = [
	{ key: "w", ctrlOrMeta: true, shift: false, alt: false },   // Close tab
	{ key: "n", ctrlOrMeta: true, shift: false, alt: false },   // New window
	{ key: "Tab", ctrlOrMeta: true, shift: false, alt: false }, // Next tab
	{ key: "l", ctrlOrMeta: true, shift: false, alt: false },   // Address bar
	{ key: "d", ctrlOrMeta: true, shift: false, alt: false },   // Bookmark
	{ key: "q", ctrlOrMeta: true, shift: false, alt: false },   // Quit
	{ key: "r", ctrlOrMeta: true, shift: false, alt: false },   // Reload
	{ key: "p", ctrlOrMeta: true, shift: false, alt: false },   // Print
	{ key: "f", ctrlOrMeta: true, shift: false, alt: false },   // Find
];

export function isBrowserReserved(binding: KeyBinding): boolean {
	return BROWSER_RESERVED.some((reserved) => bindingsEqual(reserved, binding));
}

// ============================================================================
// KEYDOWN LISTENER
// ============================================================================

function matchesBinding(e: KeyboardEvent, b: KeyBinding): boolean {
	const modMatch = b.ctrlOrMeta
		? (isMac ? e.metaKey : e.ctrlKey)
		: !(isMac ? e.metaKey : e.ctrlKey);
	return (
		modMatch &&
		e.shiftKey === b.shift &&
		e.altKey === b.alt &&
		e.key.toLowerCase() === b.key.toLowerCase()
	);
}

function isInputFocused(): boolean {
	const active = document.activeElement;
	if (!active) return false;

	// Check the directly focused element
	if (isInputElement(active)) return true;

	// Check inside shadow DOM
	const shadowActive = (active as any).shadowRoot?.activeElement;
	if (shadowActive && isInputElement(shadowActive)) return true;

	return false;
}

function isInputElement(el: Element): boolean {
	const tag = el.tagName.toLowerCase();
	if (tag === "input" || tag === "textarea") return true;
	if (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") return true;
	return false;
}

function handleKeydown(e: KeyboardEvent): void {
	// Ignore bare modifier presses
	if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;

	const inputFocused = isInputFocused();

	for (const entry of shortcuts.values()) {
		for (const binding of entry.currentBindings) {
			if (matchesBinding(e, binding)) {
				// Allow in input if: explicitly flagged, or the binding uses a modifier key
				if (inputFocused && !entry.allowInInput && !binding.ctrlOrMeta && !binding.alt) continue;
				e.preventDefault();
				entry.handler();
				return;
			}
		}
	}
}

let listening = false;

export function startListening(): void {
	if (listening) return;
	listening = true;
	window.addEventListener("keydown", handleKeydown);
}

export function stopListening(): void {
	if (!listening) return;
	listening = false;
	window.removeEventListener("keydown", handleKeydown);
}

// ============================================================================
// PERSISTENCE
// ============================================================================

export async function loadSavedBindings(): Promise<void> {
	try {
		const res = await gatewayFetch("/api/preferences");
		if (!res.ok) return;
		const prefs = await res.json();
		const saved = prefs.shortcuts as Record<string, KeyBinding[]> | undefined;
		if (!saved) return;

		for (const [id, bindings] of Object.entries(saved)) {
			const entry = shortcuts.get(id);
			if (entry && Array.isArray(bindings) && bindings.length > 0) {
				entry.currentBindings = bindings.map((b) => ({ ...b }));
			}
		}
	} catch {
		// Silently ignore — use defaults
	}
}

export async function saveBindings(): Promise<void> {
	try {
		const data: Record<string, KeyBinding[]> = {};
		for (const entry of shortcuts.values()) {
			// Only save if current differs from default
			const isDefault =
				entry.currentBindings.length === entry.defaultBindings.length &&
				entry.currentBindings.every((cb, i) => bindingsEqual(cb, entry.defaultBindings[i]));
			if (!isDefault) {
				data[entry.id] = entry.currentBindings.map((b) => ({ ...b }));
			}
		}
		const value = Object.keys(data).length > 0 ? data : null;
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ shortcuts: value }),
		});
	} catch {
		// Silently ignore
	}
}
