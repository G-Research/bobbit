/**
 * API E2E — default-disabled built-in pack resolution (server-side mechanism).
 *
 * A pack whose manifest declares `defaultDisabled: true` ships DORMANT: on a
 * fresh server it lists in the Marketplace but resolves with EVERY contributed
 * entity de-activated (tools / provider / entrypoints / runtime all absent)
 * UNTIL the user explicitly enables it OR it is "already configured" (a live
 * setup must keep working untouched). An explicit user toggle always wins and
 * persists.
 *
 * This drives the END-TO-END server wiring (resolver injection into the
 * server-scope activation store + the activation PUT's force-enable marker + the
 * `/api/marketplace/installed` payload field) through the real REST endpoints. We
 * use a SYNTHETIC server-scope pack (a fresh, uniquely-named pack we fully own)
 * rather than the built-in `hindsight` pack so the matrix is deterministic and
 * cannot be contaminated by sibling Hindsight specs sharing the worker gateway.
 *
 * Observable surface: `GET /api/marketplace/pack-activation` returns the
 * EFFECTIVE `disabled` refs (the overlay applies through getPackActivation), so a
 * dormant pack reports all entities disabled and an enabled pack reports `{}`.
 */
import { test as base, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import fs from "node:fs";
import path from "node:path";

const test = base;

const PACK_NAME = "edt-dormant";
const PROVIDER_ID = "mem";
const TOOL_NAME = "edt_dormant_tool";
// Mirror providerConfigStoreKey(PROVIDER_ID) in pack-contributions.ts.
const CONFIG_STORE_KEY = `provider-config:${PROVIDER_ID}`;

/** Percent-encode every non-alphanumeric byte — mirrors pack-store.ts::encodeKey. */
function encodeStoreKey(key: string): string {
	const bytes = Buffer.from(key, "utf8");
	let out = "";
	for (const b of bytes) {
		const isAlnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
		out += isAlnum ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** Lay down a minimal server-scope market pack that ships `defaultDisabled: true`,
 *  with one tool group + one memory provider (for the configured-check). */
function installPack(bobbitDir: string): void {
	const root = path.join(bobbitDir, ".bobbit", "config", "market-packs", PACK_NAME);
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(path.join(root, "tools", "g"), { recursive: true });
	fs.mkdirSync(path.join(root, "providers"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "pack.yaml"),
		[
			"schema: 2",
			`name: ${PACK_NAME}`,
			"description: synthetic default-disabled pack for E2E",
			"version: 1.0.0",
			"defaultDisabled: true",
			"contents:",
			"  roles: []",
			"  tools: [g]",
			"  skills: []",
			"  entrypoints: []",
			`  providers: [${PROVIDER_ID}]`,
			"  runtimes: []",
			"",
		].join("\n"),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(root, "tools", "g", `${TOOL_NAME}.yaml`),
		[`name: ${TOOL_NAME}`, "description: synthetic dormant tool", "params: []", ""].join("\n"),
		"utf-8",
	);
	// Provider yaml only needs a valid id/kind/module for the contributions loader
	// (the configured-check reads its id; the module need not be functional here).
	fs.writeFileSync(path.join(root, "provider.mjs"), "export default {};\n", "utf-8");
	fs.writeFileSync(
		path.join(root, "providers", `${PROVIDER_ID}.yaml`),
		[
			`id: ${PROVIDER_ID}`,
			"kind: memory",
			"module: ../provider.mjs",
			"config:",
			"  mode: { type: enum, values: [external, managed, managed-external-postgres], default: external }",
			"  externalUrl: { type: string, optional: true }",
			"activation:",
			"  requiresConfig: [externalUrl]",
			"",
		].join("\n"),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(root, ".pack-meta.yaml"),
		[
			"sourceUrl: e2e",
			"sourceRef: local",
			"commit: test",
			`packName: ${PACK_NAME}`,
			"version: 1.0.0",
			"installedAt: '2026-01-01T00:00:00.000Z'",
			"updatedAt: '2026-01-01T00:00:00.000Z'",
			"scope: server",
			"",
		].join("\n"),
		"utf-8",
	);
}

/** Seed (or clear) the provider config in the pack-scoped store. */
function seedConfig(bobbitDir: string, config: Record<string, unknown> | null): void {
	const dir = path.join(bobbitDir, "state", "ext-store", PACK_NAME);
	const file = path.join(dir, `${encodeStoreKey(CONFIG_STORE_KEY)}.json`);
	if (config === null) { fs.rmSync(file, { force: true }); return; }
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ v: 1, value: config }), "utf-8");
}

/** GET the effective disabled-entity refs for the pack at server scope. */
async function effectiveDisabled(): Promise<Record<string, string[]>> {
	const resp = await apiFetch(`/api/marketplace/pack-activation?scope=server&packName=${PACK_NAME}`);
	const text = await resp.text();
	expect(resp.status, text).toBe(200);
	return (JSON.parse(text) as { disabled: Record<string, string[]> }).disabled;
}

/** PUT the pack's disabled-entity refs at server scope. */
async function putActivation(disabled: Record<string, string[]>): Promise<void> {
	const resp = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled }),
	});
	const text = await resp.text();
	expect(resp.status, text).toBe(200);
}

async function installedRow(): Promise<Record<string, unknown> | undefined> {
	const resp = await apiFetch("/api/marketplace/installed");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	return (body.installed as Array<Record<string, unknown>>).find((p) => p.packName === PACK_NAME);
}

const isAllEnabled = (d: Record<string, string[]>): boolean =>
	Object.keys(d).every((k) => (d[k] ?? []).length === 0);

test.describe.configure({ mode: "serial" });

test.describe("default-disabled pack resolution (server-side)", () => {
	let bobbitDir: string;

	test.beforeAll(async ({ gateway }) => {
		bobbitDir = gateway.bobbitDir;
		installPack(bobbitDir);
	});

	test.afterAll(() => {
		fs.rmSync(path.join(bobbitDir, ".bobbit", "config", "market-packs", PACK_NAME), { recursive: true, force: true });
		seedConfig(bobbitDir, null);
	});

	test("installed payload exposes defaultDisabled + requiresGuidedSetup", async () => {
		const row = await installedRow();
		expect(row, "pack appears in the installed payload").toBeTruthy();
		expect(row!.defaultDisabled).toBe(true);
		expect(row!.requiresGuidedSetup).toBe(true);
	});

	test("fresh (unconfigured, untouched) ⇒ resolves DISABLED (all entities)", async () => {
		seedConfig(bobbitDir, null); // not configured
		const disabled = await effectiveDisabled();
		// The synthesized overlay disables every contributed entity (tool + provider).
		expect(disabled.tools, "tool de-activated").toContain(TOOL_NAME);
		expect(disabled.providers, "provider de-activated").toContain(PROVIDER_ID);
		expect(isAllEnabled(disabled)).toBe(false);
	});

	test("already configured (externalUrl) ⇒ resolves ENABLED (live-setup preservation)", async () => {
		seedConfig(bobbitDir, { mode: "external", externalUrl: "http://localhost:9177" });
		expect(isAllEnabled(await effectiveDisabled()), "configured ⇒ all enabled").toBe(true);
	});

	test("managed mode ⇒ resolves ENABLED even without externalUrl", async () => {
		seedConfig(bobbitDir, { mode: "managed" });
		expect(isAllEnabled(await effectiveDisabled())).toBe(true);
	});

	test("explicit enable (force marker) ⇒ ENABLED even when NOT configured, and persists over config clear", async () => {
		seedConfig(bobbitDir, null); // clear config first
		// PUT all-enabled = explicit user enable → force-enable marker recorded.
		await putActivation({ roles: [], tools: [], skills: [], entrypoints: [], providers: [], runtimes: [] });
		expect(isAllEnabled(await effectiveDisabled()), "explicit enable wins over default-disabled").toBe(true);
		// Still enabled with NO config — proves it's the marker, not the configured rule.
		seedConfig(bobbitDir, null);
		expect(isAllEnabled(await effectiveDisabled())).toBe(true);
	});

	test("explicit disable ⇒ DISABLED even when configured (explicit choice wins)", async () => {
		seedConfig(bobbitDir, { mode: "external", externalUrl: "http://localhost:9177" });
		await putActivation({ tools: [TOOL_NAME], providers: [PROVIDER_ID] });
		const disabled = await effectiveDisabled();
		expect(disabled.tools).toContain(TOOL_NAME);
		expect(disabled.providers).toContain(PROVIDER_ID);
	});
});
