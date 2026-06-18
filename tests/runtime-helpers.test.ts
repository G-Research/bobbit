/**
 * Unit — P1 pure runtime helper utilities.
 *
 * Covers:
 *   - idempotent generated-secret persistence + value format;
 *   - .env rendering with stable key order, dotenv escaping, and 0600 mode
 *     (including correcting a pre-existing file's mode);
 *   - host-port allocate / persist / boot-revalidate (keep available, reallocate
 *     invalid or unavailable persisted ports);
 *   - mode-specific invocation for managed vs external Postgres (external omits
 *     `db` and injects HINDSIGHT_API_DATABASE_URL; LLM key from configured
 *     secret).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getOrCreateRuntimeSecret,
	generateSecretValue,
	renderRuntimeEnvFile,
	escapeDotenvValue,
	allocateHostPort,
	revalidateHostPort,
	isPortAvailable,
	substitutePlaceholders,
	buildPlaceholderVars,
	resolveRuntimeEnv,
	buildRuntimeInvocation,
	type SecretLike,
	type PortStore,
} from "../src/server/runtime/helpers.ts";
import { parseRuntimeManifest, type RuntimeManifest } from "../src/server/runtime/manifest.ts";

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-helpers-")); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

function memSecretStore(initial: Record<string, string> = {}): SecretLike & { data: Record<string, string> } {
	const data = { ...initial };
	return { data, get: (k) => data[k], set: (k, v) => { data[k] = v; } };
}

function memPortStore(initial: Record<string, number> = {}): PortStore & { data: Record<string, number> } {
	const data = { ...initial };
	return { data, get: (k) => data[k], set: (k, v) => { data[k] = v; } };
}

// ── Secrets ────────────────────────────────────────────────────────────────

describe("getOrCreateRuntimeSecret", () => {
	it("generates, persists, and is idempotent", () => {
		const store = memSecretStore();
		const first = getOrCreateRuntimeSecret(store, "k");
		assert.ok(first.length > 0);
		assert.equal(store.data["k"], first);
		const second = getOrCreateRuntimeSecret(store, "k");
		assert.equal(second, first, "repeat call returns the same persisted value");
	});

	it("returns an existing non-empty value unchanged", () => {
		const store = memSecretStore({ k: "preset" });
		assert.equal(getOrCreateRuntimeSecret(store, "k"), "preset");
	});

	it("regenerates when the stored value is empty", () => {
		const store = memSecretStore({ k: "" });
		const v = getOrCreateRuntimeSecret(store, "k", () => "fresh");
		assert.equal(v, "fresh");
		assert.equal(store.data["k"], "fresh");
	});

	it("default generator yields a base64url string of expected length", () => {
		const v = generateSecretValue();
		// 24 bytes base64url → 32 chars, no padding, url-safe alphabet only.
		assert.equal(v.length, 32);
		assert.match(v, /^[A-Za-z0-9_-]+$/);
	});
});

// ── Env rendering ────────────────────────────────────────────────────────────

describe("renderRuntimeEnvFile", () => {
	it("writes sorted keys with mode 0600", () => {
		const file = path.join(tmp, "a", "b", ".env");
		renderRuntimeEnvFile(file, { ZED: "1", ALPHA: "2" });
		const content = fs.readFileSync(file, "utf-8");
		assert.equal(content, 'ALPHA="2"\nZED="1"\n');
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});

	it("corrects the mode of a pre-existing file", () => {
		const file = path.join(tmp, "preexisting.env");
		fs.writeFileSync(file, "stale", { mode: 0o644 });
		fs.chmodSync(file, 0o644);
		renderRuntimeEnvFile(file, { K: "v" });
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	});

	it("escapes dotenv-hostile characters", () => {
		assert.equal(escapeDotenvValue('a"b'), '"a\\"b"');
		assert.equal(escapeDotenvValue("a\\b"), '"a\\\\b"');
		assert.equal(escapeDotenvValue("a\nb"), '"a\\nb"');
		assert.equal(escapeDotenvValue("a\rb"), '"a\\rb"');
	});
});

// ── Host ports ────────────────────────────────────────────────────────────────

describe("allocateHostPort / revalidateHostPort", () => {
	it("allocates and persists a fresh port", async () => {
		const store = memPortStore();
		const p = await allocateHostPort(store, "api");
		assert.ok(p >= 1 && p <= 65535);
		assert.equal(store.data["api"], p);
	});

	it("keeps an available persisted port", async () => {
		// First obtain a known-free port via probe.
		const store = memPortStore();
		const first = await allocateHostPort(store, "api");
		const again = await revalidateHostPort(store, "api");
		assert.equal(again, first, "available persisted port is kept");
	});

	it("reallocates an invalid persisted port", async () => {
		const store = memPortStore({ api: 0 });
		const p = await revalidateHostPort(store, "api");
		assert.notEqual(p, 0);
		assert.ok(p >= 1 && p <= 65535);
		assert.equal(store.data["api"], p);
	});

	it("reallocates when the persisted port is unavailable (in use)", async () => {
		// Occupy a port so revalidation must move off it.
		const server = net.createServer();
		const busy: number = await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (addr && typeof addr === "object") resolve(addr.port);
				else reject(new Error("no port"));
			});
		});
		try {
			assert.equal(await isPortAvailable(busy), false);
			const store = memPortStore({ api: busy });
			const p = await revalidateHostPort(store, "api");
			assert.notEqual(p, busy, "unavailable persisted port is replaced");
			assert.equal(store.data["api"], p);
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});
});

// ── Placeholders + env resolution ────────────────────────────────────────────

describe("substitutePlaceholders", () => {
	it("substitutes vars and applies defaults", () => {
		assert.equal(substitutePlaceholders("${dataDir:-~/.hindsight}", {}), "~/.hindsight");
		assert.equal(substitutePlaceholders("${dataDir:-~/.hindsight}", { dataDir: "/data" }), "/data");
		assert.equal(substitutePlaceholders("pre-${x}-post", { x: "Y" }), "pre-Y-post");
	});
	it("resolves an unresolved placeholder to empty", () => {
		assert.equal(substitutePlaceholders("${missing}", {}), "");
		assert.equal(substitutePlaceholders("a${missing}b", {}), "ab");
	});
});

// ── Mode-specific invocation ──────────────────────────────────────────────────

const PACK_ROOT = path.resolve("/packs/hindsight");
const SRC = path.join(PACK_ROOT, "runtimes", "hindsight.yaml");

const MANIFEST: RuntimeManifest = {
	id: "hindsight",
	composeFile: "../runtime/compose.yaml",
	env: {
		HINDSIGHT_API_LLM_API_KEY: { secret: "hindsight.llm.apiKey" },
		HINDSIGHT_DATA_DIR: "${dataDir:-~/.hindsight}",
	},
	modes: {
		"managed-postgres": {
			services: ["api", "web", "db"],
			env: { HINDSIGHT_DB_PASSWORD: { generate: "hindsight.db.password" } },
		},
		"external-postgres": {
			services: ["api", "web", "db"],
			omitServices: ["db"],
			requireEnv: ["HINDSIGHT_API_DATABASE_URL"],
			env: { HINDSIGHT_API_DATABASE_URL: "${databaseUrl}" },
		},
	},
};

describe("resolveRuntimeEnv", () => {
	it("merges manifest + mode env and resolves refs", () => {
		const env = resolveRuntimeEnv(MANIFEST, MANIFEST.modes!["managed-postgres"], {
			secrets: { "hindsight.llm.apiKey": "sk-user" },
			generated: { "hindsight.db.password": "gen-pw" },
			vars: { dataDir: "/var/hindsight" },
		});
		assert.equal(env.HINDSIGHT_API_LLM_API_KEY, "sk-user");
		assert.equal(env.HINDSIGHT_DB_PASSWORD, "gen-pw");
		assert.equal(env.HINDSIGHT_DATA_DIR, "/var/hindsight");
	});

	it("throws on a missing configured secret", () => {
		assert.throws(
			() => resolveRuntimeEnv(MANIFEST, MANIFEST.modes!["managed-postgres"], { generated: { "hindsight.db.password": "x" } }),
			/missing configured secret/,
		);
	});
});

describe("buildPlaceholderVars + value-ref interpolation", () => {
	it("exposes generated/secret/port values under their keys for ${...} value refs", () => {
		const vars = buildPlaceholderVars({
			secrets: { API_KEY: "sk" },
			generated: { DB_PW: "gen-pw" },
			ports: { WEB: 31000 },
			vars: { dataDir: "/data" },
		});
		assert.equal(vars.DB_PW, "gen-pw");
		assert.equal(vars.API_KEY, "sk");
		assert.equal(vars.WEB, "31000");
		assert.equal(vars.dataDir, "/data");
	});

	it("explicit vars win over generated/secret on key collision", () => {
		const vars = buildPlaceholderVars({ generated: { X: "gen" }, vars: { X: "explicit" } });
		assert.equal(vars.X, "explicit");
	});

	it("resolves a value ref that interpolates a generated secret by its key", () => {
		const manifest: RuntimeManifest = {
			id: "r",
			composeFile: "../runtime/compose.yaml",
			modes: {
				m: {
					env: {
						DB_PASSWORD: { generate: "DB_PASSWORD" },
						DATABASE_URL: { value: "postgres://u:${DB_PASSWORD}@db:5432/app" },
					},
				},
			},
		};
		const env = resolveRuntimeEnv(manifest, manifest.modes!.m, {
			generated: { DB_PASSWORD: "s3cr3t" },
		});
		assert.equal(env.DB_PASSWORD, "s3cr3t");
		assert.equal(env.DATABASE_URL, "postgres://u:s3cr3t@db:5432/app");
	});
});

describe("buildRuntimeInvocation", () => {
	const envFile = path.join(tmp, "hindsight.env");

	it("managed-postgres keeps the db service and managed env", () => {
		const inv = buildRuntimeInvocation(MANIFEST, "managed-postgres", {
			sourceFile: SRC,
			packRoot: PACK_ROOT,
			envFile,
			ctx: {
				secrets: { "hindsight.llm.apiKey": "sk-user" },
				generated: { "hindsight.db.password": "gen-pw" },
				vars: { dataDir: "/data" },
			},
		});
		assert.deepEqual(inv.services, ["api", "web", "db"]);
		assert.equal(inv.composeFile, path.join(PACK_ROOT, "runtime", "compose.yaml"));
		assert.equal(inv.env.HINDSIGHT_API_LLM_API_KEY, "sk-user");
		assert.equal(inv.env.HINDSIGHT_DB_PASSWORD, "gen-pw");
		assert.equal(inv.envFile, envFile);
	});

	it("external-postgres omits db and injects HINDSIGHT_API_DATABASE_URL", () => {
		const inv = buildRuntimeInvocation(MANIFEST, "external-postgres", {
			sourceFile: SRC,
			packRoot: PACK_ROOT,
			envFile,
			ctx: {
				secrets: { "hindsight.llm.apiKey": "sk-user" },
				vars: { databaseUrl: "postgres://ext/db" },
			},
		});
		assert.deepEqual(inv.services, ["api", "web"], "db service omitted");
		assert.equal(inv.env.HINDSIGHT_API_DATABASE_URL, "postgres://ext/db");
		assert.equal(inv.env.HINDSIGHT_API_LLM_API_KEY, "sk-user", "LLM key from configured secret");
	});

	it("throws when a required env is missing", () => {
		assert.throws(
			() => buildRuntimeInvocation(MANIFEST, "external-postgres", {
				sourceFile: SRC,
				packRoot: PACK_ROOT,
				envFile,
				ctx: { secrets: { "hindsight.llm.apiKey": "sk" }, vars: {} },
			}),
			/requires env 'HINDSIGHT_API_DATABASE_URL'/,
		);
	});

	it("throws on an unknown mode", () => {
		assert.throws(
			() => buildRuntimeInvocation(MANIFEST, "nope", { sourceFile: SRC, packRoot: PACK_ROOT, envFile }),
			/no mode 'nope'/,
		);
	});
});

// ── Real Hindsight pack manifest (regression) ─────────────────────────────────
//
// Guards against the manifest/parser-helper schema mismatch: the SHIPPED
// market-packs/hindsight/runtimes/hindsight.yaml must parse and build coherent
// managed + external invocations.

describe("real market-packs/hindsight runtime manifest", () => {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const packRoot = path.join(repoRoot, "market-packs", "hindsight");
	const sourceFile = path.join(packRoot, "runtimes", "hindsight.yaml");
	const envFile = path.join(tmp, "real-hindsight.env");

	function loadManifest(): RuntimeManifest {
		const problems: string[] = [];
		const m = parseRuntimeManifest(fs.readFileSync(sourceFile, "utf-8"), sourceFile, packRoot, problems);
		assert.ok(m, `manifest must parse; problems: ${JSON.stringify(problems)}`);
		assert.deepEqual(problems, []);
		return m as RuntimeManifest;
	}

	it("parses the shipped descriptor", () => {
		const m = loadManifest();
		assert.equal(m.id, "hindsight");
		assert.equal(m.composeFile, "../runtime/compose.yaml");
		assert.ok(m.modes?.["managed-postgres"]);
		assert.ok(m.modes?.["external-postgres"]);
		// Generated secrets are declared with `generate: true`, not env `secret:` refs.
		const keys = (m.secrets ?? []).map((s) => s.key).sort();
		assert.deepEqual(keys, ["HINDSIGHT_API_SECRET", "HINDSIGHT_DB_PASSWORD"]);
		assert.ok((m.secrets ?? []).every((s) => s.generate === true));
		// Port specs use `container`, not `target`.
		const ports = (m.ports ?? []).map((p) => p.key).sort();
		assert.deepEqual(ports, ["HINDSIGHT_API_PORT", "HINDSIGHT_WEB_PORT"]);
		assert.ok((m.ports ?? []).every((p) => typeof p.container === "number"));
	});

	it("builds managed-postgres: includes db, LLM key from configured secret, DB URL has generated password", () => {
		const m = loadManifest();
		const inv = buildRuntimeInvocation(m, "managed-postgres", {
			sourceFile,
			packRoot,
			envFile,
			ctx: {
				secrets: { HINDSIGHT_API_LLM_API_KEY: "sk-configured" },
				generated: { HINDSIGHT_API_SECRET: "api-secret", HINDSIGHT_DB_PASSWORD: "gen-db-pw" },
				ports: { HINDSIGHT_WEB_PORT: 31000, HINDSIGHT_API_PORT: 31001 },
				vars: { dataDir: "/var/lib/hindsight" },
			},
		});
		assert.deepEqual(inv.services, ["api", "web", "db"], "managed services include db");
		assert.equal(inv.composeFile, path.join(packRoot, "runtime", "compose.yaml"));
		assert.equal(inv.env.HINDSIGHT_API_LLM_API_KEY, "sk-configured", "LLM key from configured secret");
		assert.equal(inv.env.HINDSIGHT_API_SECRET, "api-secret");
		assert.equal(inv.env.HINDSIGHT_DATA_DIR, "/var/lib/hindsight");
		// Managed DB URL is assembled from the GENERATED password.
		assert.equal(
			inv.env.HINDSIGHT_API_DATABASE_URL,
			"postgres://hindsight:gen-db-pw@db:5432/hindsight",
			"managed DB URL contains the generated password",
		);
		assert.ok(inv.env.HINDSIGHT_API_DATABASE_URL.includes("gen-db-pw"));
	});

	it("builds external-postgres: omits db, DB URL from configured secret", () => {
		const m = loadManifest();
		const inv = buildRuntimeInvocation(m, "external-postgres", {
			sourceFile,
			packRoot,
			envFile,
			ctx: {
				secrets: {
					HINDSIGHT_API_LLM_API_KEY: "sk-configured",
					HINDSIGHT_API_DATABASE_URL: "postgres://operator@ext-host:5432/hindsight",
				},
				generated: { HINDSIGHT_API_SECRET: "api-secret" },
				ports: { HINDSIGHT_WEB_PORT: 31000, HINDSIGHT_API_PORT: 31001 },
			},
		});
		assert.deepEqual(inv.services, ["api", "web"], "external omits db");
		assert.ok(!inv.services.includes("db"));
		assert.equal(inv.env.HINDSIGHT_API_LLM_API_KEY, "sk-configured", "LLM key from configured secret");
		assert.equal(
			inv.env.HINDSIGHT_API_DATABASE_URL,
			"postgres://operator@ext-host:5432/hindsight",
			"external DB URL from configured secret",
		);
	});

	it("external-postgres requires HINDSIGHT_API_DATABASE_URL", () => {
		const m = loadManifest();
		assert.throws(
			() =>
				buildRuntimeInvocation(m, "external-postgres", {
					sourceFile,
					packRoot,
					envFile,
					ctx: {
						secrets: { HINDSIGHT_API_LLM_API_KEY: "sk", HINDSIGHT_API_DATABASE_URL: "" },
						generated: { HINDSIGHT_API_SECRET: "x" },
						ports: { HINDSIGHT_WEB_PORT: 1, HINDSIGHT_API_PORT: 2 },
					},
				}),
			/requires env 'HINDSIGHT_API_DATABASE_URL'/,
		);
	});
});
