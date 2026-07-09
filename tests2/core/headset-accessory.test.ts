// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
//
/**
 * Pins the "headset" accessory end-to-end wiring.
 *
 * Adding an accessory touches several decoupled places (canonical sprite data,
 * the box-shadow CSS overlay, the blob DOM templates, the role-manager inline
 * display rules, the sidebar canvas seat special-case, and the staff
 * allowlist). This test guards each so a future refactor can't silently drop
 * one and leave the headset invisible in one context but not another.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCESSORIES, ACCESSORY_IDS, ACCESSORY_HEADSET } from "../../src/ui/bobbit-sprite-data.ts";
import { normalizeStaffAccessory } from "../../src/server/agent/staff-store.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const has = (x: number, y: number, c: string) =>
	ACCESSORY_HEADSET.pixels.some(([px, py, pc]) => px === x && py === y && pc === c);

describe("headset accessory", () => {
	it("is registered in the canonical sprite registry", () => {
		assert.equal(ACCESSORIES["headset"], ACCESSORY_HEADSET);
		assert.ok(ACCESSORY_IDS.includes("headset"));
		assert.equal(ACCESSORY_HEADSET.id, "headset");
		assert.equal(ACCESSORY_HEADSET.label, "Headset");
	});

	it("is an addsHeight hat seated like the crown (yOffset 2)", () => {
		assert.equal(ACCESSORY_HEADSET.addsHeight, true, "band rises above the head");
		assert.equal(ACCESSORY_HEADSET.yOffset, 2);
		assert.equal(ACCESSORY_HEADSET.blobYAdjust, -1);
	});

	it("has a headband with BOTH a top and its own bottom outline", () => {
		// Top outline over the crown at row -2.
		assert.ok(has(4, -2, "#000") && has(5, -2, "#000"), "band top outline at row -2");
		// Dedicated bottom outline under the crown at row 0 (drawn over the head
		// so it tracks the fractional seat rather than borrowing the head edge).
		assert.ok(
			has(3, 0, "#000") && has(4, 0, "#000") && has(5, 0, "#000") && has(6, 0, "#000"),
			"band bottom outline at row 0",
		);
	});

	it("has two charcoal ear cups over the eye row", () => {
		// Left cushion highlight + right cushion highlight on row 4.
		assert.ok(has(0, 4, "#4b5563") && has(9, 4, "#4b5563"), "cushion highlights at row 4");
		assert.ok(has(1, 4, "#374151") && has(8, 4, "#374151"), "cushion bodies at row 4");
	});

	it("has a boom mic ending in an orange foam windscreen", () => {
		assert.ok(has(4, 6, "#f97316"), "orange foam at the mouth");
		assert.ok(has(7, 7, "#374151") && has(8, 7, "#374151"), "boom arm from the right cup");
	});

	it("uses only neutral greys + the foam pop (stays neutral across hues)", () => {
		const allowed = new Set(["#000", "#1f2937", "#374151", "#4b5563", "#6b7280", "#f97316"]);
		for (const [, , c] of ACCESSORY_HEADSET.pixels) {
			assert.ok(allowed.has(c), `unexpected headset colour ${c}`);
		}
	});

	it("is allowed as a staff accessory", () => {
		assert.equal(normalizeStaffAccessory("headset"), "headset");
	});

	it("is wired into every blob render context", () => {
		const css = read("src/ui/app.css");
		assert.match(css, /\.bobbit-headset \.bobbit-blob__headset \{/, "app.css overlay rule");
		assert.match(css, /\.bobbit-blob--archived \.bobbit-blob__headset/, "archived animation-kill list");
		// Seats half a sprite-pixel DOWN via the independent translate lever.
		assert.match(css, /\.bobbit-headset \.bobbit-blob__headset[\s\S]*?translate:\s*0 2px/, "downward seat translate");

		// DOM templates (chat blob + idle blob, streaming container).
		const render = read("src/ui/bobbit-render.ts");
		const chatDivs = render.match(/bobbit-blob__headset/g) ?? [];
		assert.ok(chatDivs.length >= 2, "headset div in both bobbit-render templates");
		// Sidebar canvas seat special-case (+0.5 sprite px).
		assert.match(render, /isHeadset/, "sidebar accTransform seat special-case");
		assert.match(read("src/ui/components/StreamingMessageContainer.ts"), /bobbit-blob__headset/);

		// Role-manager inline display rules (per-blob gating, no html-class leak).
		const rm = read("src/app/role-manager.css");
		assert.match(rm, /\.bobbit-blob--inline\.bobbit-headset \.bobbit-blob__headset \{ display: block/, "inline enable rule");
		assert.match(rm, /\.bobbit-blob--inline \.bobbit-blob__headset/, "inline reset rule");
	});
});
