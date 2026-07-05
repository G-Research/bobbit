/**
 * Built-in opt-in defaults — boot seed unit tests.
 *
 * Covers the one-time boot seed (src/server/agent/builtin-pack-defaults.ts) that
 * ships `experiment-runner` PRESENT but DISABLED by default:
 *   - boot seeds server-scope pack_activation disabling all of the pack's
 *     entrypoints when no marker exists;
 *   - the durable marker persists, so a second boot does NOT re-disable a pack
 *     the user has since enabled (cleared refs + marker present ⇒ stays enabled);
 *   - idempotency; never throws; a not-shipped pack is a no-op.
 *
 * The built-in band is pointed at the repo `market-packs/` dir via the
 * `builtinPacksDir` option — no dist build required.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_MARKET_PACKS = path.join(__dirname, "..", "market-packs");

const mod = await import("../src/server/agent/builtin-pack-defaults.ts");
const {
	seedBuiltinPackDefaults,
	buildFullyDisabledRefs,
	FIRST_PARTY_PACKS_DISABLED_BY_DEFAULT,
	BUILTIN_PACK_DEFAULTS_MARKER,
} = mod;
const { ProjectConfigStore } = await import("../src/server/agent/project-config-store.ts");
const { builtinFirstPartyPackEntries } = await import("../src/server/agent/builtin-packs.ts");

const PACK = "experiment-runner";
const ENTRYPOINTS = ["experiment-runner-open", "experiment-runner-palette", "experiment-runner-route"];

let tmp: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-defaults-"));
	stateDir = path.join(tmp, "state");
	configDir = path.join(tmp, "config");
	fs.mkdirSync(stateDir, { recursive: true });
	fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("builtin-pack-defaults seed", () => {
	it("lists experiment-runner (and only it) as opt-in", () => {
		assert.deepEqual([...FIRST_PARTY_PACKS_DISABLED_BY_DEFAULT], [PACK]);
	});

	// Regression pin: every FIRST_PARTY_PACKS_DISABLED_BY_DEFAULT pack must also
	// be in scripts/copy-builtin-packs.mjs's FIRST_PARTY_PACKS allowlist, or it
	// never actually ships in dist/server/builtin-packs/ — seedBuiltinPackDefaults
	// then silently no-ops ("not actually shipped as a built-in") with no error,
	// no crash, just an absent pack. This exact drop (experiment-runner missing
	// from FIRST_PARTY_PACKS) shipped invisibly through unit tests, which point
	// builtinPacksDir at the repo market-packs/ dir directly and never exercise
	// the real copy-builtin-packs.mjs allowlist; only the E2E suite against a
	// real dist build caught it (tests/e2e/ui/experiment-runner.spec.ts).
	it("scripts/copy-builtin-packs.mjs ships every FIRST_PARTY_PACKS_DISABLED_BY_DEFAULT pack", () => {
		const scriptPath = path.join(__dirname, "..", "scripts", "copy-builtin-packs.mjs");
		const src = fs.readFileSync(scriptPath, "utf-8");
		const match = src.match(/const FIRST_PARTY_PACKS = \[([^\]]*)\]/);
		assert.ok(match, "FIRST_PARTY_PACKS allowlist must be present in scripts/copy-builtin-packs.mjs");
		const shipped = match![1]
			.split(",")
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
		for (const packName of FIRST_PARTY_PACKS_DISABLED_BY_DEFAULT) {
			assert.ok(
				shipped.includes(packName),
				`"${packName}" must be in scripts/copy-builtin-packs.mjs's FIRST_PARTY_PACKS allowlist or the opt-in boot seed silently no-ops`,
			);
		}
	});

	it("buildFullyDisabledRefs disables every entrypoint the pack declares", () => {
		const entry = builtinFirstPartyPackEntries(REPO_MARKET_PACKS).find((e) => e.manifest?.name === PACK);
		assert.ok(entry, "experiment-runner must ship as a built-in");
		const refs = buildFullyDisabledRefs(entry as never);
		for (const ep of ENTRYPOINTS) assert.ok((refs.entrypoints ?? []).includes(ep), `entrypoint ${ep} must be disabled`);
	});

	it("seeds disabled-by-default when no marker exists", () => {
		const store = new ProjectConfigStore(configDir);
		assert.deepEqual(store.getPackActivation("server", PACK), {}, "starts enabled (no override)");

		const seeded = seedBuiltinPackDefaults({ stateDir, store, builtinPacksDir: REPO_MARKET_PACKS });
		assert.deepEqual(seeded, [PACK]);

		const disabled = store.getPackActivation("server", PACK);
		for (const ep of ENTRYPOINTS) assert.ok((disabled.entrypoints ?? []).includes(ep), `entrypoint ${ep} disabled`);

		// Marker persisted.
		const markerPath = path.join(stateDir, BUILTIN_PACK_DEFAULTS_MARKER);
		assert.ok(fs.existsSync(markerPath), "marker file must be written");
		const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
		assert.deepEqual(marker.seeded, [PACK]);
	});

	it("does NOT re-disable after the user enables (marker present, refs cleared)", () => {
		// First boot seeds disabled.
		const store = new ProjectConfigStore(configDir);
		seedBuiltinPackDefaults({ stateDir, store, builtinPacksDir: REPO_MARKET_PACKS });

		// User enables: clears the disabled refs.
		store.setPackActivation("server", PACK, {});
		assert.deepEqual(store.getPackActivation("server", PACK), {}, "user-enabled ⇒ no override");

		// Second boot (fresh store reading the same on-disk config + marker).
		const restarted = new ProjectConfigStore(configDir);
		const seeded2 = seedBuiltinPackDefaults({ stateDir, store: restarted, builtinPacksDir: REPO_MARKET_PACKS });
		assert.deepEqual(seeded2, [], "must NOT re-seed when the marker is present");
		assert.deepEqual(restarted.getPackActivation("server", PACK), {}, "stays enabled across restart");
	});

	it("is idempotent — a repeated seed on the same boot is a no-op", () => {
		const store = new ProjectConfigStore(configDir);
		const first = seedBuiltinPackDefaults({ stateDir, store, builtinPacksDir: REPO_MARKET_PACKS });
		assert.deepEqual(first, [PACK]);
		const second = seedBuiltinPackDefaults({ stateDir, store, builtinPacksDir: REPO_MARKET_PACKS });
		assert.deepEqual(second, [], "second call must not re-seed");
	});

	it("respects an existing admin override (does not overwrite) but records the marker", () => {
		const store = new ProjectConfigStore(configDir);
		// Admin already set a partial override BEFORE the seed runs.
		store.setPackActivation("server", PACK, { entrypoints: ["experiment-runner-open"] });
		const seeded = seedBuiltinPackDefaults({ stateDir, store, builtinPacksDir: REPO_MARKET_PACKS });
		assert.deepEqual(seeded, [], "existing entry ⇒ no seed");
		assert.deepEqual(store.getPackActivation("server", PACK), { entrypoints: ["experiment-runner-open"] });
		// Marker recorded so a later clear never gets re-disabled.
		const marker = JSON.parse(fs.readFileSync(path.join(stateDir, BUILTIN_PACK_DEFAULTS_MARKER), "utf-8"));
		assert.deepEqual(marker.seeded, [PACK]);
	});

	it("is a no-op (no marker, no throw) when the pack is not shipped as a built-in", () => {
		const emptyDir = path.join(tmp, "empty-packs");
		fs.mkdirSync(emptyDir, { recursive: true });
		const store = new ProjectConfigStore(configDir);
		const seeded = seedBuiltinPackDefaults({ stateDir, store, builtinPacksDir: emptyDir });
		assert.deepEqual(seeded, []);
		assert.deepEqual(store.getPackActivation("server", PACK), {});
		// Not shipped ⇒ NOT marked (so it gets seeded if/when it later ships).
		const markerPath = path.join(stateDir, BUILTIN_PACK_DEFAULTS_MARKER);
		assert.equal(fs.existsSync(markerPath), false);
	});

	it("never throws on a broken state dir", () => {
		const store = new ProjectConfigStore(configDir);
		assert.doesNotThrow(() =>
			seedBuiltinPackDefaults({ stateDir: "\0invalid", store, builtinPacksDir: REPO_MARKET_PACKS }),
		);
	});
});
