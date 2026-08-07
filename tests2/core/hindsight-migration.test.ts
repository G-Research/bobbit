import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packRoot = path.join(root, "market-packs/hindsight");
const migrationPath = path.join(packRoot, "src/migration.ts");
const composePath = path.join(packRoot, "runtime/compose.yaml");
const implemented = fs.existsSync(migrationPath);

function source(file: string): string {
	return fs.readFileSync(file, "utf8");
}

describe.skipIf(!implemented)("Hindsight logical PostgreSQL migration", () => {
	it("uses a durable owned named volume and never bind-mounts legacy pg0 data", () => {
		const compose = source(composePath);
		const parsed = YAML.parse(compose) as { services?: { db?: { volumes?: string[] } }; volumes?: Record<string, unknown> };
		const dbVolumes = parsed.services?.db?.volumes ?? [];
		assert.ok(dbVolumes.some(volume => /^[A-Za-z0-9_-]+:\/var\/lib\/postgresql\/data/.test(volume)),
			"Compose must own PostgreSQL data through a named volume, not a host data directory");
		assert.ok(parsed.volumes && Object.keys(parsed.volumes).length > 0, "the durable named volume must be declared at Compose top level");
		assert.doesNotMatch(compose, /pg0|(?:HINDSIGHT_DATA_DIR|\$\{[^}]*DATA[^}]*\}):\/var\/lib\/postgresql\/data/i,
			"the live legacy pg0/data directory must never be bind-mounted into a container");
	});

	it("makes plans compatibility-checked, fingerprinted, backed up, and reversible", () => {
		const text = source(migrationPath);
		for (const required of ["fingerprint", "pg_dump", "pg_restore", "backup", "rollback", "schema", "Postgres", "free"])
			assert.match(text, new RegExp(required, "i"), `migration source must account for ${required}`);
		assert.match(text, /custom(?:-format| format)|\s-F\s*c/i, "backup must use pg_dump custom format");
		assert.match(text, /confirm/i, "execution must require explicit operator confirmation");
		assert.match(text, /writer|quiesce|stop/i, "writers must be stopped before dumping");
		assert.match(text, /marker/i, "restore verification must include a known retained marker");
		assert.match(text, /retain/i);
		assert.match(text, /recall/i);
		assert.match(text, /reflect/i);
	});

	it("refuses destructive replacement without the exact plan fingerprint and preserves the old authority on failure", () => {
		const text = source(migrationPath);
		assert.match(text, /confirmation[^\n]*(?:fingerprint|plan)|(?:fingerprint|plan)[^\n]*confirmation/i,
			"execution must bind the typed confirmation to the reviewed plan fingerprint");
		assert.match(text, /(?:keep|preserve|retain)[^\n]*(?:old|source|volume|endpoint)|(?:old|source|volume|endpoint)[^\n]*(?:keep|preserve|retain)/i,
			"source storage remains authoritative until a verified restore succeeds");
		assert.match(text, /(?:catch|failure|error)[\s\S]{0,500}(?:rollback|source|old)/i,
			"a restore failure must leave a rollback path rather than selecting an empty target bank");
		assert.doesNotMatch(text, /rm\s+-rf|--volumes|volume\s+rm/i,
			"ordinary migration planning/execution must not destroy an existing volume");
	});
});
