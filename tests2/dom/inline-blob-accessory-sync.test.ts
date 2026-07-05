// Migrated from tests/inline-blob-accessory-sync.spec.ts (v2-dom tier).
// The legacy fixture hand-copied a minimal CSS repro and asserted, via
// getComputedStyle, that inline-blob accessories inherit the same
// animation-delay stagger as the eye sprite (the bug: accessories started at
// t=0, desynced from the eyes). happy-dom's getComputedStyle resolves the CSS
// cascade + nested var() fallbacks, so we port at HIGHER fidelity: we pull the
// REAL animation-delay rules straight out of src/app/role-manager.css (rather
// than a hand-written copy) and assert the same computed delays. Injecting the
// whole stylesheet trips happy-dom's parser, so we extract just the two rules
// under test (sprite + accessory-sync) — both keyed on the real
// `animation-delay: var(--bobbit-idle-phase, var(--bobbit-eye-delay, 0s))`.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Read the REAL stylesheet from disk (vite's `?raw` CSS import resolves to an
// empty string under this config, so we go straight to the source file).
const roleCss = readFileSync(resolve(process.cwd(), "src/app/role-manager.css"), "utf-8");

/** Extract every rule block whose body sets the real staggered animation-delay
 *  (the inline sprite rule + the accessory-sync rule). Keeps this faithful to
 *  the actual source instead of a copy that could drift. */
function extractDelayRules(css: string): string {
	const blocks = css.match(/[^{}]+\{[^{}]*\}/g) || [];
	const wanted = blocks.filter((b) => /animation-delay:\s*var\(--bobbit-idle-phase/.test(b));
	return wanted.join("\n");
}

const accessories = [
	{ name: "magnifier", delay: "3s" },
	{ name: "bandana", delay: "5s" },
	{ name: "palette", delay: "2s" },
	{ name: "pencil", delay: "4s" },
	{ name: "shield", delay: "7s" },
	{ name: "set-square", delay: "1s" },
	{ name: "flask", delay: "6s" },
];

function mountBlob(name: string, delay: string) {
	const wrap = document.createElement("div");
	wrap.className = `bobbit-blob--inline bobbit-blob--idle bobbit-${name}`;
	wrap.style.setProperty("--bobbit-eye-delay", delay);
	wrap.dataset.testid = `blob-${name}`;
	const sprite = document.createElement("div");
	sprite.className = "bobbit-blob__sprite";
	const accessory = document.createElement("div");
	accessory.className = `bobbit-blob__${name}`;
	wrap.append(sprite, accessory);
	document.body.appendChild(wrap);
	return { wrap, sprite, accessory };
}

beforeAll(() => {
	const extracted = extractDelayRules(roleCss);
	// Sanity: both the sprite rule and the accessory-sync rule must be present so
	// this test genuinely exercises the real fix, not an empty stylesheet.
	expect(extracted).toMatch(/bobbit-blob__sprite/);
	expect(extracted).toMatch(/bobbit-blob__flask/);
	const style = document.createElement("style");
	style.id = "role-manager-delay-rules";
	style.textContent = extracted;
	document.head.appendChild(style);
});

afterEach(() => { document.body.innerHTML = ""; });

describe("Inline blob accessory animation-delay sync", () => {
	it("sprite gets animation-delay from --bobbit-eye-delay (control)", () => {
		const { sprite } = mountBlob("magnifier", "3s");
		expect(getComputedStyle(sprite).animationDelay).toBe("3s");
	});

	for (const { name, delay } of accessories) {
		it(`${name} accessory animation-delay should match --bobbit-eye-delay (${delay})`, () => {
			const { accessory } = mountBlob(name, delay);
			expect(getComputedStyle(accessory).animationDelay, "accessory animation-delay should match --bobbit-eye-delay").toBe(delay);
		});
	}
});
