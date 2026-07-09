import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/color-migration.spec.ts (v2-dom tier).
// The legacy fixture inlined the migration index mappings and a `migrateIndex`
// helper. This port exercises the REAL migration logic through ColorStore
// (server/agent/color-store.ts), which reads a persisted colors file at an old
// palette version and remaps every index to the current 14-colour palette. The
// current palette hues come from the REAL BOBBIT_HUE_ROTATIONS (bobbit-render.ts).
// The V1/V3 source palettes are legacy test data (documented in color-store.ts).
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ColorStore } from "../../src/server/agent/color-store.js";
import { BOBBIT_HUE_ROTATIONS } from "../../src/ui/bobbit-render.js";

// Current 14-colour palette (hue rotations) — the real source of truth.
const NEW_PALETTE = BOBBIT_HUE_ROTATIONS;
// Legacy source palettes (input hues), documented in color-store.ts.
const V1_PALETTE = [0, 25, 50, 75, 100, 125, 150, 175, 200, 225, -135, -110, -85, -60, -35, -10, 15, 40, 65, 250];
const V3_PALETTE = [0, 25, 50, 75, 100, 125, 150, 175, -135, -110, -85, -60, -35, -10, 15, 40, 65];

const tmpDirs: string[] = [];

/** Migrate indices 0..count-1 from an old palette version via the real ColorStore. */
function migrateAll(fromVersion: number, count: number): number[] {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "color-mig-"));
	tmpDirs.push(dir);
	const seed: Record<string, unknown> = { _paletteVersion: fromVersion };
	for (let i = 0; i < count; i++) seed[`s${i}`] = i;
	fs.writeFileSync(path.join(dir, "session-colors.json"), JSON.stringify(seed), "utf-8");
	const store = new ColorStore(dir);
	const all = store.getAll();
	return Array.from({ length: count }, (_, i) => all[`s${i}`]);
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});

describe("V1 (20-colour) → current (14-colour) migration", () => {
	it("all migrated indices are within 0-13", () => {
		const migrated = migrateAll(1, 20);
		for (const n of migrated) {
			expect(n).toBeGreaterThanOrEqual(0);
			expect(n).toBeLessThanOrEqual(13);
		}
	});

	it("preserved hues map to correct new index", () => {
		const m = migrateAll(1, 20);
		// V1[0]=0°, V1[3]=75°, V1[4]=100°, V1[11]=-110° all survive into the new palette.
		for (const i of [0, 3, 4, 11]) {
			expect(V1_PALETTE[i]).toBe(NEW_PALETTE[m[i]]);
		}
	});
});

describe("V3 (17-colour) → current (14-colour) migration", () => {
	it("all migrated indices are within 0-13", () => {
		const migrated = migrateAll(3, 17);
		for (const n of migrated) {
			expect(n).toBeGreaterThanOrEqual(0);
			expect(n).toBeLessThanOrEqual(13);
		}
	});

	it("preserved hues map correctly", () => {
		const m = migrateAll(3, 17);
		// V3[0]=0°, V3[9]=-110°, V3[16]=65° survive.
		for (const i of [0, 9, 16]) {
			expect(V3_PALETTE[i]).toBe(NEW_PALETTE[m[i]]);
		}
	});

	it("removed hues (150°, 175°, -135°) map to nearest", () => {
		const m = migrateAll(3, 17);
		expect(m[6]).toBe(13); // 150° → 125° (nearest)
		expect(m[7]).toBe(13); // 175° → 125° (nearest)
		expect(m[8]).toBe(0); // -135° → -110° (nearest)
	});
});
