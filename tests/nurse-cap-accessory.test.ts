/**
 * Pins the "nurse-cap" accessory end-to-end wiring.
 *
 * Adding an accessory touches several decoupled places (canonical sprite data,
 * the box-shadow CSS overlay, the blob DOM templates, the role-manager inline
 * display rules, and the staff allowlist). This test guards each of those so a
 * future refactor can't silently drop one and leave the cap invisible in one
 * context but not another.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCESSORIES, ACCESSORY_IDS, ACCESSORY_NURSE_CAP } from "../src/ui/bobbit-sprite-data.ts";
import { normalizeStaffAccessory } from "../src/server/agent/staff-store.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("nurse-cap accessory", () => {
	it("is registered in the canonical sprite registry", () => {
		assert.equal(ACCESSORIES["nurse-cap"], ACCESSORY_NURSE_CAP);
		assert.ok(ACCESSORY_IDS.includes("nurse-cap"));
		assert.equal(ACCESSORY_NURSE_CAP.id, "nurse-cap");
		assert.equal(ACCESSORY_NURSE_CAP.label, "Nurse Cap");
	});

	it("is an addsHeight hat seated like the crown (yOffset 2, brim outline at row 2)", () => {
		assert.equal(ACCESSORY_NURSE_CAP.addsHeight, true, "must add height like crown/wizard-hat");
		assert.equal(ACCESSORY_NURSE_CAP.yOffset, 2, "must share the crown's yOffset so it seats above the eyes");
		// Brim outline: a contiguous black span across x1..9 at row 2 — the exact
		// row the crown / wizard-hat brim sits on.
		const brim = ACCESSORY_NURSE_CAP.pixels
			.filter(([, y, c]) => y === 2 && c === "#000")
			.map(([x]) => x)
			.sort((a, b) => a - b);
		assert.deepEqual(brim, [1, 2, 3, 4, 5, 6, 7, 8, 9], "brim outline must span x1..9 at row 2");
	});

	it("renders a centred red cross on white", () => {
		const has = (x: number, y: number, c: string) =>
			ACCESSORY_NURSE_CAP.pixels.some(([px, py, pc]) => px === x && py === y && pc === c);
		// Vertical bar of the cross at x5, rows -1..1
		assert.ok(has(5, -1, "#ef4444") && has(5, 0, "#ef4444") && has(5, 1, "#ef4444"), "cross vertical at x5");
		// Horizontal arms at row 0, x4..6
		assert.ok(has(4, 0, "#ef4444") && has(6, 0, "#ef4444"), "cross arms at row 0");
		// White cap body present
		assert.ok(ACCESSORY_NURSE_CAP.pixels.some(([, , c]) => c === "#ffffff"), "white cap body");
	});

	it("is allowed as a staff accessory", () => {
		assert.equal(normalizeStaffAccessory("nurse-cap"), "nurse-cap");
	});

	it("is wired into every blob render context", () => {
		// Box-shadow overlay + counter hue-rotate (stays white+red across hues).
		const css = read("src/ui/app.css");
		assert.match(css, /\.bobbit-nurse-cap \.bobbit-blob__nurse-cap \{/, "app.css overlay rule");
		assert.match(css, /\.bobbit-blob--archived \.bobbit-blob__nurse-cap/, "archived animation-kill list");
		// DOM templates (chat blob, idle blob, streaming container).
		const render = read("src/ui/bobbit-render.ts");
		const chatDivs = render.match(/bobbit-blob__nurse-cap/g) ?? [];
		assert.ok(chatDivs.length >= 2, "nurse-cap div in both bobbit-render templates");
		assert.match(read("src/ui/components/StreamingMessageContainer.ts"), /bobbit-blob__nurse-cap/);
		// Role-manager inline display rules (per-blob gating, no html-class leak).
		const rm = read("src/app/role-manager.css");
		assert.match(rm, /\.bobbit-blob--inline\.bobbit-nurse-cap \.bobbit-blob__nurse-cap \{ display: block/, "inline enable rule");
		assert.match(rm, /\.bobbit-blob--inline \.bobbit-blob__nurse-cap/, "inline reset rule");
	});
});
