import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/shortcut-registry.html")}`;

function reg(page: any) {
	return page.evaluate("window.__registry");
}

test.describe("Shortcut Registry", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).__registry.clearAll());
	});

	// ========================================================================
	// 1. registerShortcut + getShortcuts
	// ========================================================================
	test("registerShortcut adds entry, getShortcuts returns it", async ({ page }) => {
		const count = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.registerShortcut({
				id: "test-1",
				label: "Test One",
				category: "Testing",
				defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }],
				handler: () => {},
			});
			return r.getShortcuts().length;
		});
		expect(count).toBe(1);

		const entry = await page.evaluate(() => {
			const r = (window as any).__registry;
			const e = r.getShortcutById("test-1");
			return { id: e.id, label: e.label, category: e.category };
		});
		expect(entry).toEqual({ id: "test-1", label: "Test One", category: "Testing" });
	});

	// ========================================================================
	// 2. currentBindings auto-cloned from defaultBindings
	// ========================================================================
	test("currentBindings auto-cloned from defaultBindings when omitted", async ({ page }) => {
		const result = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.registerShortcut({
				id: "clone-test",
				label: "Clone",
				category: "Test",
				defaultBindings: [{ key: "c", ctrlOrMeta: true, shift: false, alt: false }],
				handler: () => {},
			});
			const e = r.getShortcutById("clone-test");
			// currentBindings should equal defaultBindings
			const equal = r.bindingsEqual(e.currentBindings[0], e.defaultBindings[0]);
			// But should NOT be the same object reference
			const sameRef = e.currentBindings[0] === e.defaultBindings[0];
			return { equal, sameRef, len: e.currentBindings.length };
		});
		expect(result.equal).toBe(true);
		expect(result.sameRef).toBe(false);
		expect(result.len).toBe(1);
	});

	// ========================================================================
	// 3. findConflict detects conflicts
	// ========================================================================
	test("findConflict detects binding conflicts", async ({ page }) => {
		const conflictId = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.registerShortcut({
				id: "action-a",
				label: "Action A",
				category: "Test",
				defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }],
				handler: () => {},
			});
			r.registerShortcut({
				id: "action-b",
				label: "Action B",
				category: "Test",
				defaultBindings: [{ key: "s", ctrlOrMeta: true, shift: false, alt: false }],
				handler: () => {},
			});
			const conflict = r.findConflict({ key: "t", ctrlOrMeta: true, shift: false, alt: false });
			return conflict?.id;
		});
		expect(conflictId).toBe("action-a");
	});

	// ========================================================================
	// 4. findConflict returns undefined for non-conflicting
	// ========================================================================
	test("findConflict returns undefined for non-conflicting bindings", async ({ page }) => {
		const result = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.registerShortcut({
				id: "only-action",
				label: "Only",
				category: "Test",
				defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }],
				handler: () => {},
			});
			return r.findConflict({ key: "s", ctrlOrMeta: true, shift: false, alt: false });
		});
		expect(result).toBeUndefined();
	});

	// ========================================================================
	// 5. findConflict with excludeId
	// ========================================================================
	test("findConflict with excludeId excludes that shortcut", async ({ page }) => {
		const result = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.registerShortcut({
				id: "self",
				label: "Self",
				category: "Test",
				defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }],
				handler: () => {},
			});
			// Same binding but excluding "self" — no conflict
			const conflict = r.findConflict(
				{ key: "t", ctrlOrMeta: true, shift: false, alt: false },
				"self",
			);
			return conflict;
		});
		expect(result).toBeUndefined();
	});

	// ========================================================================
	// 6. formatBinding platform-aware (Mac vs non-Mac)
	// ========================================================================
	test("formatBinding shows Cmd on Mac, Ctrl on non-Mac", async ({ page }) => {
		const results = await page.evaluate(() => {
			const r = (window as any).__registry;
			const binding = { key: "t", ctrlOrMeta: true, shift: false, alt: false };

			r.setMac(false);
			const win = r.formatBinding(binding);

			r.setMac(true);
			const mac = r.formatBinding(binding);

			r.setMac(false); // reset
			return { win, mac };
		});
		expect(results.win).toBe("Ctrl+T");
		expect(results.mac).toBe("Cmd+T");
	});

	// ========================================================================
	// 7. formatBinding special keys
	// ========================================================================
	test("formatBinding formats special keys", async ({ page }) => {
		const results = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.setMac(false);
			return {
				up: r.formatBinding({ key: "ArrowUp", ctrlOrMeta: true, shift: false, alt: false }),
				down: r.formatBinding({ key: "ArrowDown", ctrlOrMeta: true, shift: false, alt: false }),
				left: r.formatBinding({ key: "ArrowLeft", ctrlOrMeta: false, shift: false, alt: true }),
				right: r.formatBinding({ key: "ArrowRight", ctrlOrMeta: false, shift: false, alt: true }),
				esc: r.formatBinding({ key: "Escape", ctrlOrMeta: false, shift: false, alt: false }),
				backspace: r.formatBinding({ key: "Backspace", ctrlOrMeta: false, shift: false, alt: false }),
			};
		});
		expect(results.up).toBe("Ctrl+↑");
		expect(results.down).toBe("Ctrl+↓");
		expect(results.left).toBe("Alt+←");
		expect(results.right).toBe("Alt+→");
		expect(results.esc).toBe("Esc");
		expect(results.backspace).toBe("⌫");
	});

	// ========================================================================
	// 8. resetBinding restores defaults for a single shortcut
	// ========================================================================
	test("resetBinding restores default bindings", async ({ page }) => {
		const result = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.registerShortcut({
				id: "reset-test",
				label: "Reset Test",
				category: "Test",
				defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }],
				handler: () => {},
			});
			// Change binding
			r.updateBinding("reset-test", 0, { key: "x", ctrlOrMeta: true, shift: false, alt: false });
			const before = r.getShortcutById("reset-test").currentBindings[0].key;

			// Reset
			r.resetBinding("reset-test");
			const after = r.getShortcutById("reset-test").currentBindings[0].key;

			return { before, after };
		});
		expect(result.before).toBe("x");
		expect(result.after).toBe("t");
	});

	// ========================================================================
	// 9. resetAllBindings restores all defaults
	// ========================================================================
	test("resetAllBindings restores all defaults", async ({ page }) => {
		const result = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.registerShortcut({
				id: "a",
				label: "A",
				category: "T",
				defaultBindings: [{ key: "a", ctrlOrMeta: true, shift: false, alt: false }],
				handler: () => {},
			});
			r.registerShortcut({
				id: "b",
				label: "B",
				category: "T",
				defaultBindings: [{ key: "b", ctrlOrMeta: true, shift: false, alt: false }],
				handler: () => {},
			});
			r.updateBinding("a", 0, { key: "x", ctrlOrMeta: true, shift: false, alt: false });
			r.updateBinding("b", 0, { key: "y", ctrlOrMeta: true, shift: false, alt: false });

			r.resetAllBindings();

			return {
				aKey: r.getShortcutById("a").currentBindings[0].key,
				bKey: r.getShortcutById("b").currentBindings[0].key,
			};
		});
		expect(result.aKey).toBe("a");
		expect(result.bKey).toBe("b");
	});

	// ========================================================================
	// 10. updateBinding changes a specific binding at an index
	// ========================================================================
	test("updateBinding changes a specific binding at an index", async ({ page }) => {
		const result = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.registerShortcut({
				id: "update-test",
				label: "Update",
				category: "T",
				defaultBindings: [
					{ key: "a", ctrlOrMeta: true, shift: false, alt: false },
					{ key: "b", ctrlOrMeta: false, shift: false, alt: true },
				],
				handler: () => {},
			});
			r.updateBinding("update-test", 1, { key: "z", ctrlOrMeta: false, shift: true, alt: false });
			const entry = r.getShortcutById("update-test");
			return {
				first: entry.currentBindings[0].key,
				second: entry.currentBindings[1].key,
				secondShift: entry.currentBindings[1].shift,
			};
		});
		expect(result.first).toBe("a"); // unchanged
		expect(result.second).toBe("z"); // updated
		expect(result.secondShift).toBe(true);
	});

	// ========================================================================
	// 11. isBrowserReserved
	// ========================================================================
	test("isBrowserReserved returns true for Ctrl+W, false for Ctrl+T", async ({ page }) => {
		const result = await page.evaluate(() => {
			const r = (window as any).__registry;
			return {
				ctrlW: r.isBrowserReserved({ key: "w", ctrlOrMeta: true, shift: false, alt: false }),
				ctrlT: r.isBrowserReserved({ key: "t", ctrlOrMeta: true, shift: false, alt: false }),
				ctrlN: r.isBrowserReserved({ key: "n", ctrlOrMeta: true, shift: false, alt: false }),
				altG: r.isBrowserReserved({ key: "g", ctrlOrMeta: false, shift: false, alt: true }),
			};
		});
		expect(result.ctrlW).toBe(true);
		expect(result.ctrlT).toBe(false);
		expect(result.ctrlN).toBe(true);
		expect(result.altG).toBe(false);
	});

	// ========================================================================
	// 12. Keydown matching: matchesBinding
	// ========================================================================
	test("matchesBinding correctly matches keyboard events", async ({ page }) => {
		const results = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.setMac(false);

			const binding = { key: "t", ctrlOrMeta: true, shift: false, alt: false };

			// Simulate matching event
			const match = r.matchesBinding(
				{ key: "t", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
				binding,
			);

			// Wrong key
			const wrongKey = r.matchesBinding(
				{ key: "s", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
				binding,
			);

			// Missing ctrl
			const noCtrl = r.matchesBinding(
				{ key: "t", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
				binding,
			);

			// Extra shift
			const extraShift = r.matchesBinding(
				{ key: "t", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false },
				binding,
			);

			// Case insensitive
			const caseInsensitive = r.matchesBinding(
				{ key: "T", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
				binding,
			);

			return { match, wrongKey, noCtrl, extraShift, caseInsensitive };
		});
		expect(results.match).toBe(true);
		expect(results.wrongKey).toBe(false);
		expect(results.noCtrl).toBe(false);
		expect(results.extraShift).toBe(false);
		expect(results.caseInsensitive).toBe(true);
	});

	test("matchesBinding uses metaKey on Mac", async ({ page }) => {
		const result = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.setMac(true);
			const binding = { key: "t", ctrlOrMeta: true, shift: false, alt: false };

			const metaMatch = r.matchesBinding(
				{ key: "t", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
				binding,
			);
			const ctrlNoMatch = r.matchesBinding(
				{ key: "t", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
				binding,
			);

			r.setMac(false);
			return { metaMatch, ctrlNoMatch };
		});
		expect(result.metaMatch).toBe(true);
		expect(result.ctrlNoMatch).toBe(false);
	});

	// ========================================================================
	// 13. Keydown: no handler fires for unregistered combo
	// ========================================================================
	test("no handler fires for unregistered combo", async ({ page }) => {
		const fired = await page.evaluate(() => {
			const r = (window as any).__registry;
			let called = false;
			r.registerShortcut({
				id: "specific",
				label: "Specific",
				category: "T",
				defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }],
				handler: () => { called = true; },
			});
			r.startListening();

			// Dispatch an unrelated combo (Ctrl+S)
			document.dispatchEvent(new KeyboardEvent("keydown", {
				key: "s",
				ctrlKey: true,
				bubbles: true,
			}));

			return called;
		});
		expect(fired).toBe(false);
	});

	test("handler fires for registered combo via keydown", async ({ page }) => {
		const fired = await page.evaluate(() => {
			const r = (window as any).__registry;
			let called = false;
			r.registerShortcut({
				id: "fire-test",
				label: "Fire",
				category: "T",
				defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }],
				allowInInput: true,
				handler: () => { called = true; },
			});
			r.startListening();

			document.dispatchEvent(new KeyboardEvent("keydown", {
				key: "t",
				ctrlKey: true,
				bubbles: true,
			}));

			return called;
		});
		expect(fired).toBe(true);
	});

	// ========================================================================
	// Input guard tests
	// ========================================================================
	test("handler NOT called when input focused and allowInInput is false", async ({ page }) => {
		const fired = await page.evaluate(() => {
			const r = (window as any).__registry;
			let called = false;
			r.registerShortcut({
				id: "no-input",
				label: "No Input",
				category: "T",
				defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }],
				// allowInInput defaults to undefined/false
				handler: () => { called = true; },
			});
			r.startListening();

			// Focus the input
			document.getElementById("test-input").focus();

			document.dispatchEvent(new KeyboardEvent("keydown", {
				key: "g",
				altKey: true,
				bubbles: true,
			}));

			return called;
		});
		expect(fired).toBe(false);
	});

	test("allowInInput shortcut fires even when input focused", async ({ page }) => {
		const fired = await page.evaluate(() => {
			const r = (window as any).__registry;
			let called = false;
			r.registerShortcut({
				id: "allow-input",
				label: "Allow Input",
				category: "T",
				defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }],
				allowInInput: true,
				handler: () => { called = true; },
			});
			r.startListening();

			document.getElementById("test-input").focus();

			document.dispatchEvent(new KeyboardEvent("keydown", {
				key: "t",
				ctrlKey: true,
				bubbles: true,
			}));

			return called;
		});
		expect(fired).toBe(true);
	});

	test("handler NOT called when textarea focused and allowInInput is false", async ({ page }) => {
		const fired = await page.evaluate(() => {
			const r = (window as any).__registry;
			let called = false;
			r.registerShortcut({
				id: "no-textarea",
				label: "No TA",
				category: "T",
				defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }],
				handler: () => { called = true; },
			});
			r.startListening();

			document.getElementById("test-textarea").focus();

			document.dispatchEvent(new KeyboardEvent("keydown", {
				key: "g",
				altKey: true,
				bubbles: true,
			}));

			return called;
		});
		expect(fired).toBe(false);
	});

	test("handler NOT called when contenteditable focused and allowInInput is false", async ({ page }) => {
		const fired = await page.evaluate(() => {
			const r = (window as any).__registry;
			let called = false;
			r.registerShortcut({
				id: "no-ce",
				label: "No CE",
				category: "T",
				defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }],
				handler: () => { called = true; },
			});
			r.startListening();

			document.getElementById("test-contenteditable").focus();

			document.dispatchEvent(new KeyboardEvent("keydown", {
				key: "g",
				altKey: true,
				bubbles: true,
			}));

			return called;
		});
		expect(fired).toBe(false);
	});

	test("handler fires when non-input div is focused", async ({ page }) => {
		const fired = await page.evaluate(() => {
			const r = (window as any).__registry;
			let called = false;
			r.registerShortcut({
				id: "div-focus",
				label: "Div",
				category: "T",
				defaultBindings: [{ key: "g", ctrlOrMeta: false, shift: false, alt: true }],
				// allowInInput: false (default)
				handler: () => { called = true; },
			});
			r.startListening();

			// Focus a plain div (tabindex needed to actually focus)
			const div = document.getElementById("test-div");
			div.setAttribute("tabindex", "0");
			div.focus();

			document.dispatchEvent(new KeyboardEvent("keydown", {
				key: "g",
				altKey: true,
				bubbles: true,
			}));

			return called;
		});
		expect(fired).toBe(true);
	});

	// ========================================================================
	// Bare modifier press ignored
	// ========================================================================
	test("bare modifier keypress does not fire handlers", async ({ page }) => {
		const fired = await page.evaluate(() => {
			const r = (window as any).__registry;
			let called = false;
			r.registerShortcut({
				id: "mod-test",
				label: "Mod",
				category: "T",
				defaultBindings: [{ key: "t", ctrlOrMeta: true, shift: false, alt: false }],
				allowInInput: true,
				handler: () => { called = true; },
			});
			r.startListening();

			// Dispatch bare Control press
			document.dispatchEvent(new KeyboardEvent("keydown", {
				key: "Control",
				ctrlKey: true,
				bubbles: true,
			}));

			return called;
		});
		expect(fired).toBe(false);
	});

	// ========================================================================
	// Multi-binding support
	// ========================================================================
	test("multiple bindings for same action both fire handler", async ({ page }) => {
		const result = await page.evaluate(() => {
			const r = (window as any).__registry;
			let count = 0;
			r.registerShortcut({
				id: "multi",
				label: "Multi",
				category: "T",
				defaultBindings: [
					{ key: "t", ctrlOrMeta: true, shift: false, alt: false },
					{ key: "n", ctrlOrMeta: false, shift: false, alt: true },
				],
				allowInInput: true,
				handler: () => { count++; },
			});
			r.startListening();

			// First binding: Ctrl+T
			document.dispatchEvent(new KeyboardEvent("keydown", {
				key: "t", ctrlKey: true, bubbles: true,
			}));

			// Second binding: Alt+N
			document.dispatchEvent(new KeyboardEvent("keydown", {
				key: "n", altKey: true, bubbles: true,
			}));

			return count;
		});
		expect(result).toBe(2);
	});

	// ========================================================================
	// formatBinding with shift+alt combos
	// ========================================================================
	test("formatBinding includes Shift and Alt modifiers", async ({ page }) => {
		const result = await page.evaluate(() => {
			const r = (window as any).__registry;
			r.setMac(false);
			return r.formatBinding({ key: "d", ctrlOrMeta: true, shift: true, alt: false });
		});
		expect(result).toBe("Ctrl+Shift+D");
	});
});
