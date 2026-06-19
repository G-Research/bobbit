/**
 * Unit — Hindsight runtime descriptor mode→services mapping (P3).
 *
 * Pins the design invariant (P3 "Hindsight runtime manifest/compose" §): the two
 * launch modes resolve to the correct compose service sets and DB-connection
 * source, so the P3 activation layer can map config `mode` → runtime mode safely:
 *
 *   - `managed-postgres`   → starts `api`, `web`, `db`; HINDSIGHT_API_DATABASE_URL
 *                            is the in-compose `db` URL assembled from the
 *                            GENERATED managed password.
 *   - `external-postgres`  → starts `api`, `web` only (`db` subtracted by
 *                            `omitServices`); HINDSIGHT_API_DATABASE_URL is
 *                            REQUIRED and supplied from a configured secret.
 *
 * This guards the exact descriptor mismatch the design warns about — a mode that
 * lists `db` in `services` AND in `omitServices` must net out to NO `db` once
 * `buildRuntimeInvocation()` subtracts the omitted services. It exercises the REAL
 * shipped manifest (market-packs/hindsight/runtimes/hindsight.yaml) through the
 * pure P1 parser + invocation builder — no Docker, no supervisor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseRuntimeManifest, type RuntimeManifest } from "../src/server/runtime/manifest.ts";
import { buildRuntimeInvocation, type RuntimeResolveContext } from "../src/server/runtime/helpers.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_ROOT = path.join(REPO_ROOT, "market-packs", "hindsight");
const MANIFEST_FILE = path.join(PACK_ROOT, "runtimes", "hindsight.yaml");
const COMPOSE_FILE = path.join(PACK_ROOT, "runtime", "compose.yaml");

/** Parse the REAL shipped Hindsight runtime manifest (fails loudly on drift). */
function loadManifest(): RuntimeManifest {
	const raw = fs.readFileSync(MANIFEST_FILE, "utf-8");
	const problems: string[] = [];
	const manifest = parseRuntimeManifest(raw, MANIFEST_FILE, PACK_ROOT, problems);
	assert.ok(manifest, `hindsight runtime manifest failed to validate: ${problems.join("; ")}`);
	return manifest!;
}

const ENV_FILE = path.join(REPO_ROOT, "node_modules", ".cache", "hindsight-manifest-test.env");

/**
 * A resolve context satisfying EVERY env ref the manifest declares for the given
 * mode (generated secrets, the user LLM key, allocated ports, and the optional
 * external DB URL / dataDir). `buildRuntimeInvocation` resolves the full env map
 * eagerly, so a `secret:` ref with no value throws — the tests provide exactly
 * what each mode legitimately needs (and deliberately omit the external DB URL
 * to prove the requireEnv guard fires).
 */
function ctxFor(extra: Partial<RuntimeResolveContext> = {}): RuntimeResolveContext {
	return {
		secrets: { HINDSIGHT_API_LLM_API_KEY: "llm-key", ...(extra.secrets ?? {}) },
		generated: { HINDSIGHT_API_SECRET: "api-secret", HINDSIGHT_DB_PASSWORD: "db-pass", ...(extra.generated ?? {}) },
		ports: { HINDSIGHT_WEB_PORT: 30000, HINDSIGHT_API_PORT: 38080, ...(extra.ports ?? {}) },
		...(extra.vars ? { vars: extra.vars } : {}),
	};
}

describe("Hindsight runtime manifest — mode → services mapping", () => {
	it("declares exactly the two documented modes", () => {
		const manifest = loadManifest();
		assert.deepEqual(Object.keys(manifest.modes ?? {}).sort(), ["external-postgres", "managed-postgres"]);
	});

	it("managed-postgres starts api+web+db with a generated in-compose DB url", () => {
		const manifest = loadManifest();
		const inv = buildRuntimeInvocation(manifest, "managed-postgres", {
			sourceFile: MANIFEST_FILE,
			packRoot: PACK_ROOT,
			envFile: ENV_FILE,
			ctx: ctxFor(),
		});
		// All three managed services are brought up.
		assert.deepEqual([...inv.services].sort(), ["api", "db", "web"]);
		// Managed DB url is assembled in-compose from the GENERATED password — not
		// from any user-supplied connection string.
		assert.equal(inv.env.HINDSIGHT_API_DATABASE_URL, "postgres://hindsight:db-pass@db:5432/hindsight");
		// Default managed data dir when no dataDir var is supplied.
		assert.equal(inv.env.HINDSIGHT_DATA_DIR, "~/.hindsight");
		// Ports + user LLM key are resolved into the env (managed start needs them).
		assert.equal(inv.env.HINDSIGHT_API_PORT, "38080");
		assert.equal(inv.env.HINDSIGHT_WEB_PORT, "30000");
		assert.equal(inv.env.HINDSIGHT_API_LLM_API_KEY, "llm-key");
	});

	it("managed-postgres honours a configured dataDir override for the bind volume", () => {
		const manifest = loadManifest();
		const inv = buildRuntimeInvocation(manifest, "managed-postgres", {
			sourceFile: MANIFEST_FILE,
			packRoot: PACK_ROOT,
			envFile: ENV_FILE,
			ctx: ctxFor({ vars: { dataDir: "/srv/hindsight-data" } }),
		});
		assert.equal(inv.env.HINDSIGHT_DATA_DIR, "/srv/hindsight-data");
	});

	it("the compose db bind mount interpolates the RENDERED env key, not the raw `dataDir` config (finding #1)", () => {
		// Regression: the bind mount used `${dataDir:-~/.hindsight}`, but the manifest
		// renders the managed data dir under HINDSIGHT_DATA_DIR — `dataDir` is a provider
		// CONFIG field and is NEVER written to the compose env file. So compose always
		// fell back to ~/.hindsight and a configured custom data dir was silently ignored.
		// The bind mount MUST reference the exact env var the manifest renders.
		const manifest = loadManifest();
		const inv = buildRuntimeInvocation(manifest, "managed-postgres", {
			sourceFile: MANIFEST_FILE,
			packRoot: PACK_ROOT,
			envFile: ENV_FILE,
			ctx: ctxFor({ vars: { dataDir: "/srv/hindsight-data" } }),
		});
		// The manifest renders the managed data path under this key.
		assert.equal(inv.env.HINDSIGHT_DATA_DIR, "/srv/hindsight-data");

		const compose = fs.readFileSync(COMPOSE_FILE, "utf-8");
		const bindLine = compose
			.split(/\r?\n/)
			.find((l) => l.includes("/postgres:/var/lib/postgresql/data"));
		assert.ok(bindLine, "compose must declare the managed Postgres bind mount");
		// Honours the rendered env key …
		assert.match(bindLine!, /\$\{HINDSIGHT_DATA_DIR(:-[^}]*)?\}\/postgres/);
		// … and never the raw config field name, which would always fall back to the default.
		assert.ok(
			!/\$\{dataDir(:-[^}]*)?\}/.test(bindLine!),
			"compose bind mount must not reference the raw `dataDir` config field (never written to env)",
		);
	});

	it("external-postgres subtracts db (omitServices) and injects the configured url", () => {
		const manifest = loadManifest();
		const inv = buildRuntimeInvocation(manifest, "external-postgres", {
			sourceFile: MANIFEST_FILE,
			packRoot: PACK_ROOT,
			envFile: ENV_FILE,
			ctx: ctxFor({ secrets: { HINDSIGHT_API_DATABASE_URL: "postgres://ext-host/hindsight" } }),
		});
		// `db` listed in `services` AND `omitServices` nets out to NO db.
		assert.deepEqual([...inv.services].sort(), ["api", "web"]);
		assert.ok(!inv.services.includes("db"), "external-postgres must not start the managed db service");
		// The externally-supplied URL is used verbatim (no in-compose assembly).
		assert.equal(inv.env.HINDSIGHT_API_DATABASE_URL, "postgres://ext-host/hindsight");
	});

	it("external-postgres REQUIRES HINDSIGHT_API_DATABASE_URL (absent ⇒ rejected by name)", () => {
		const manifest = loadManifest();
		assert.throws(
			() =>
				buildRuntimeInvocation(manifest, "external-postgres", {
					sourceFile: MANIFEST_FILE,
					packRoot: PACK_ROOT,
					envFile: ENV_FILE,
					ctx: ctxFor(), // external DB URL secret deliberately omitted
				}),
			/HINDSIGHT_API_DATABASE_URL/,
		);
	});
});
