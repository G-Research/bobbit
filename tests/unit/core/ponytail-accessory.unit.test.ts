//
/**
 * Pins the "ponytail" accessory end-to-end wiring.
 *
 * Adding an accessory touches several decoupled places (canonical sprite data,
 * the box-shadow CSS overlay, the blob DOM templates, the role-manager inline
 * display rules, and the staff allowlist). This test guards each so a future
 * refactor can't silently drop one and leave the ponytail invisible in one
 * context but not another.
 *
 * It also pins the two properties that are easy to "tidy" into bugs:
 *   1. The centre parting, forehead and mouth are drawn by OMISSION. If someone
 *      fills x4-x6 with body-coloured pixels it will look identical at the
 *      default hue and wrong under every other session palette.
 *   2. The right-facing turn moves the tail to negative x rather than merely
 *      hiding it, and drops the far curtain — mirroring blob-headset-shadow on
 *      the same phase stops.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ACCESSORIES,
	ACCESSORY_IDS,
	ACCESSORY_PONYTAIL,
	ACCESSORY_BANDANA,
	BODY_GRID,
	EYE_POSITIONS,
} from "../../../src/ui/bobbit-sprite-data.ts";
import { normalizeStaffAccessory } from "../../../src/server/agent/staff-store.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const px = ACCESSORY_PONYTAIL.pixels;
const at = (x: number, y: number) => px.find(([ax, ay]) => ax === x && ay === y);
const has = (x: number, y: number, c?: string) => {
	const p = at(x, y);
	return !!p && (c === undefined || p[2] === c);
};

const RIM = "#0e0d18";
const MASS = "#454363";
const SHEEN = "#7c7aa4";
const TIE = "#ef4444";
const STUBBLE = "rgba(24,23,38,0.30)";

describe("ponytail accessory", () => {
	it("is registered in the canonical sprite registry", () => {
		assert.equal(ACCESSORIES["ponytail"], ACCESSORY_PONYTAIL);
		assert.ok(ACCESSORY_IDS.includes("ponytail"));
		assert.equal(ACCESSORY_PONYTAIL.id, "ponytail");
		assert.equal(ACCESSORY_PONYTAIL.label, "Ponytail");
	});

	it("is seated without adding top height", () => {
		assert.equal(ACCESSORY_PONYTAIL.addsHeight, false, "nothing extends above row 0");
		assert.equal(ACCESSORY_PONYTAIL.yOffset, 0);
		assert.equal(ACCESSORY_PONYTAIL.blobYAdjust, 0);
	});

	it("keeps every hair pixel inside the body silhouette for its row", () => {
		for (const [x, y] of px) {
			if (x > 9) continue;
			const row = BODY_GRID[y];
			assert.ok(row, `row ${y} exists`);
			assert.notEqual(row[x], "_", `(${x},${y}) must sit on a body pixel, not empty space`);
		}
	});

	it("draws the centre parting and forehead by omission, never with body colour", () => {
		for (const x of [4, 5, 6]) {
			assert.ok(!at(x, 2), `(${x},2) must be unpainted so the body shows through`);
		}
		for (const x of [3, 4, 5, 6]) {
			assert.ok(!at(x, 3), `(${x},3) must be unpainted`);
		}
		const bodyColours = new Set(["#8ec63f", "#b5d98a", "#6b9930", "#1a3010"]);
		for (const [, , c] of px) {
			assert.ok(!bodyColours.has(c), `${c} is a body colour and must not be baked in`);
		}
	});

	it("has a centre-parted curtain fringe with a dark top rim", () => {
		for (const x of [3, 4, 5, 6, 7]) assert.ok(has(x, 0, RIM), `(${x},0) rim`);
		assert.ok(has(1, 3, MASS) && has(2, 3, MASS), "left curtain lock");
		assert.ok(has(7, 3, MASS) && has(8, 3, MASS), "right curtain lock");
		assert.ok(has(1, 4, MASS) && has(8, 4, MASS), "curtain tips at the eye row");
		assert.ok(has(3, 1, SHEEN) && has(4, 1, SHEEN), "sheen streak on the lit side");
	});

	it("reuses the bandana's tail columns so existing overflow boxes fit", () => {
		const tailX = new Set(px.filter(([x]) => x > 9).map(([x]) => x));
		const bandanaTailX = new Set(ACCESSORY_BANDANA.pixels.filter(([x]) => x > 9).map(([x]) => x));
		assert.deepEqual([...tailX].sort(), [...bandanaTailX].sort(), "same x columns as the bandana tail");
		assert.ok(has(9, 3, TIE), "hair tie at the gather");
	});

	it("keeps hair clear of the eyes in every gaze position", () => {
		for (const gaze of Object.keys(EYE_POSITIONS) as (keyof typeof EYE_POSITIONS)[]) {
			const { lx, ly, rx, ry } = EYE_POSITIONS[gaze];
			for (const [ex, ey] of [[lx, ly], [lx, ly + 1], [rx, ry], [rx, ry + 1]]) {
				const p = at(ex, ey);
				if (gaze === "up-right" && ex === 7 && ey === 3) continue;
				assert.ok(!p, `${gaze} pupil at (${ex},${ey}) must not be covered by hair`);
			}
		}
	});

	it("uses translucent stubble so it reads as growth under any hue", () => {
		const stubble = px.filter(([, , c]) => c === STUBBLE);
		assert.equal(stubble.length, 9, "3 cheek flecks + 6 jaw pixels");
		for (const x of [2, 3, 4, 5, 6, 7]) assert.ok(has(x, 7, STUBBLE), `(${x},7) jaw stubble`);
		assert.ok(has(1, 6, STUBBLE) && has(7, 6, STUBBLE) && has(8, 6, STUBBLE), "cheek flecks");
	});

	it("uses only the hair palette, the tie red and translucent stubble", () => {
		const allowed = new Set([RIM, MASS, SHEEN, TIE, STUBBLE]);
		for (const [, , c] of px) assert.ok(allowed.has(c), `unexpected ponytail colour ${c}`);
	});

	it("provides a minimal right-facing sidebar frame", () => {
		const right = ACCESSORY_PONYTAIL.sidebarRightFacingPixels ?? [];
		const rightHas = (x: number, y: number) => right.some(([px, py]) => px === x && py === y);
		assert.ok(right.length > 0 && right.length < px.length, "right frame is a pixel subset");
		assert.ok(rightHas(1, 3) && rightHas(1, 4), "near/left curtain remains visible");
		assert.ok(!rightHas(7, 3) && !rightHas(8, 4), "far/right curtain is occluded");
		assert.ok(!right.some(([x, y]) => x >= 9 && y >= 2), "right-side tail is occluded");
		assert.ok(rightHas(7, 1) && rightHas(8, 1), "crown remains intact");
		assert.ok(rightHas(7, 7), "bottom jaw sweep remains visible");
	});

	it("is allowed as a staff accessory", () => {
		assert.equal(normalizeStaffAccessory("ponytail"), "ponytail");
	});

	it("turns rather than merely hiding when the bobbit looks right", () => {
		const css = read("src/ui/app.css");
		const kf = css.slice(css.indexOf("@keyframes blob-ponytail-shadow"));
		const block = kf.slice(0, kf.indexOf("\n}"));

		for (const pct of ["0%", "34%", "57%", "60%", "65%", "96%", "98%"]) {
			assert.ok(block.includes(`\n\t${pct} {`), `phase stop ${pct}`);
		}

		const turned = block.slice(block.indexOf("34% {"), block.indexOf("57% {"));
		assert.match(turned, /-1px 3px 0 /, "turned frame draws the tail on the left");
		assert.match(turned, /-2px 4px 0 /, "turned frame tail spans two columns");
		assert.match(turned, /0px 3px 0 #ef4444/, "tie moves with the tail");
		assert.doesNotMatch(turned, /10px 3px 0 /, "right-side tail hidden on the turn");
		assert.doesNotMatch(turned, /\n\t\t7px 3px 0 /, "far curtain hidden on the turn");
		assert.doesNotMatch(turned, /7px 6px 0 /, "right cheek fleck dropped on the turn");
		assert.doesNotMatch(turned, /8px 6px 0 /, "right cheek fleck dropped on the turn");
		assert.match(turned, /7px 7px 0 /, "jaw stubble stays on the bottom row");
		const up = block.slice(block.indexOf("60% {"), block.indexOf("65% {"));
		assert.match(up, /-1px 3px 0 /, "eyes-up-right also turned");
		assert.doesNotMatch(up, /\n\t\t7px 3px 0 /, "eyes-up-right clears the up-right pupil");
	});

	it("is wired into every blob render context", () => {
		const css = read("src/ui/app.css");
		assert.match(css, /\.bobbit-ponytail \.bobbit-blob__ponytail \{/, "app.css overlay rule");
		assert.match(css, /\.bobbit-blob--archived \.bobbit-blob__ponytail/, "archived animation-kill list");
		assert.match(
			css,
			/\.bobbit-ponytail \.bobbit-blob__ponytail[\s\S]*?filter: hue-rotate\(calc\(-1 \* var\(--bobbit-hue-rotate/,
			"counter-hue-rotate keeps the tie red",
		);
		assert.match(css, /animation-name: blob-busy-move-rigid, blob-ponytail-adjust, blob-ponytail-shadow/, "rigid body motion + adjust + occlusion");
		assert.match(css, /blob-ponytail-adjust[\s\S]*?34%, 35%, 60%, 61%, 96%, 97% \{ translate: -2px 0; \}/, "turn nudge on the headset's frames");
		assert.match(css, /\.bobbit-blob--idle \.bobbit-blob__ponytail/, "sleeping idle rule");
		assert.doesNotMatch(css, /\.bobbit-ponytail \.bobbit-blob \{[\s\S]*?padding-top/, "no top padding — nothing above row 0");
		for (const state of ["exit", "exit-roll", "enter", "enter-roll", "compact-shake", "compacting", "compact-pop"]) {
			assert.ok(css.includes(`.bobbit-blob--${state} .bobbit-blob__ponytail`), `${state} state rule`);
		}

		const render = read("src/ui/bobbit-render.ts");
		const divs = render.match(/bobbit-blob__ponytail/g) ?? [];
		assert.ok(divs.length >= 2, "ponytail div in both bobbit-render templates");
		assert.match(render, /sidebarRightFacingPixels/, "sidebar consumes the occluded frame");
		assert.match(render, /showRightOnly = !!rightPixels\?\.length && unread && !isSelected/, "unread right gaze renders only the occluded frame");
		assert.match(read("src/ui/components/StreamingMessageContainer.ts"), /bobbit-blob__ponytail/);

		const rm = read("src/app/role-manager.css");
		assert.match(rm, /\.bobbit-blob--inline\.bobbit-ponytail \.bobbit-blob__ponytail \{ display: block/, "inline enable rule");
		assert.match(rm, /\.bobbit-blob--inline \.bobbit-blob__ponytail/, "inline reset rule");
	});
});
