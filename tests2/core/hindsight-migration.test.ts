import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import YAML from "yaml";

import {
	createHindsightMigrationPlan,
	executeHindsightMigration,
	migrationConfirmationFor,
	type LogicalMigrationRunner,
} from "../../market-packs/hindsight/src/migration.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composePath = path.join(root, "market-packs/hindsight/runtime/compose.yaml");

function compatibleInput() {
	return {
		source: { kind: "managed-volume" as const, volume: "hindsight-old" },
		target: { kind: "managed-volume" as const, volume: "hindsight-new" },
		backupDirectory: "/operator/backups",
		compatibility: {
			bankExists: true, markerPresent: true, sourcePostgresMajor: 16, targetPostgresMajor: 16,
			sourceSchemaVersion: "1", targetSchemaVersion: "1", freeBytes: 2_000, requiredBytes: 1_000,
		},
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

function runner(calls: string[], failVerify = false): LogicalMigrationRunner {
	return {
		stopWriters: async () => { calls.push("stop-writers"); },
		dumpCustom: async () => { calls.push("pg_dump-custom"); },
		validateDump: async () => { calls.push("validate-dump"); },
		createTarget: async () => { calls.push("create-target"); },
		restoreCustom: async () => { calls.push("pg_restore-custom"); },
		verify: async () => { calls.push("verify-retain-recall-reflect"); return { healthy: !failVerify, markerPresent: true, retainRecallReflect: !failVerify }; },
		switchActive: async () => { calls.push("switch-active"); },
		restoreSourceRouting: async () => { calls.push("restore-source-routing"); },
	};
}

describe("Hindsight logical PostgreSQL migration", () => {
	it("uses a named durable volume rather than a host PostgreSQL data mount", () => {
		const compose = YAML.parse(fs.readFileSync(composePath, "utf8")) as { services: { db: { volumes: string[] } }; volumes: Record<string, unknown> };
		assert.deepEqual(compose.services.db.volumes, ["hindsight-postgres:/var/lib/postgresql/data"]);
		assert.deepEqual(compose.volumes, { "hindsight-postgres": {} });
	});

	it("creates a compatibility-checked, fingerprinted custom backup plan and verifies before switching", async () => {
		const planned = createHindsightMigrationPlan(compatibleInput());
		assert.equal(planned.ok, true);
		if (!planned.ok) return;
		assert.equal(planned.plan.backup.format, "custom");
		assert.equal(planned.plan.confirmation, migrationConfirmationFor(planned.plan));
		assert.equal(planned.plan.rollback.action, "restore-source-routing");
		const calls: string[] = [];
		const result = await executeHindsightMigration(planned.plan, planned.plan.confirmation, runner(calls));
		assert.deepEqual(result, { ok: true, planId: planned.plan.id, fingerprint: planned.plan.fingerprint });
		assert.deepEqual(calls, ["stop-writers", "pg_dump-custom", "validate-dump", "create-target", "pg_restore-custom", "verify-retain-recall-reflect", "switch-active"]);
	});

	it("rejects unsafe plans and restores source routing when a verified replacement fails", async () => {
		assert.deepEqual(createHindsightMigrationPlan({ ...compatibleInput(), source: { kind: "managed-volume", volume: "pg0" } }), { ok: false, code: "HINDSIGHT_MIGRATION_INVALID" });
		assert.deepEqual(createHindsightMigrationPlan({ ...compatibleInput(), compatibility: { ...compatibleInput().compatibility, targetSchemaVersion: "2" } }), { ok: false, code: "HINDSIGHT_MIGRATION_INCOMPATIBLE" });
		const planned = createHindsightMigrationPlan(compatibleInput());
		assert.equal(planned.ok, true);
		if (!planned.ok) return;
		assert.deepEqual(await executeHindsightMigration(planned.plan, "MIGRATE HINDSIGHT wrong", runner([])), { ok: false, code: "HINDSIGHT_MIGRATION_CONFIRMATION_REQUIRED" });
		const calls: string[] = [];
		const result = await executeHindsightMigration(planned.plan, planned.plan.confirmation, runner(calls, true));
		assert.deepEqual(result, { ok: false, code: "HINDSIGHT_MIGRATION_FAILED", rolledBack: true });
		assert.deepEqual(calls, ["stop-writers", "pg_dump-custom", "validate-dump", "create-target", "pg_restore-custom", "verify-retain-recall-reflect", "restore-source-routing"]);
	});
});
