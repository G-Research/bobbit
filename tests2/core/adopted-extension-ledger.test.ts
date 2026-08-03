import { afterEach, beforeEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { ProjectConfigStore } from "../../src/server/agent/project-config-store.js";
import {
	AdoptionValidationError,
	adoptedMcpContribution,
	aggregateAdoptedExtensions,
	classifyAdoptionMcpHints,
	createAdoptedExtension,
	findAdoptedExtensionByIdentity,
	nextAdoptedExtensionRevision,
	reconcileAdoptionOperations,
	redactAdoptedExtension,
} from "../../src/server/agent/adopted-extensions.js";

let tempDir: string;
const NOW = new Date("2026-01-02T03:04:05.000Z");

function configFile(): string { return path.join(tempDir, "project.yaml"); }

function stdioRecord(scope: "server" | "global-user" | "project" = "server") {
	return createAdoptedExtension({
		kind: "mcp",
		scope,
		...(scope === "project" ? { projectId: "p-1" } : {}),
		source: { transport: "stdio", command: "node", args: ["fixture.mjs", "--token=secret"] },
		now: NOW,
	});
}

describe("adopted extension ledger", () => {
	beforeEach(() => { tempDir = makeTmpDir("adoption-ledger-"); });
	afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

	it("uses canonical scope identity, deterministic ids, and deterministic visibility", () => {
		const first = stdioRecord();
		const duplicate = findAdoptedExtensionByIdentity([first], {
			scope: "server",
			kind: "mcp",
			source: { transport: "stdio", command: "node", args: ["fixture.mjs", "--token=secret"] },
		});
		assert.equal(duplicate?.id, first.id);
		assert.equal(stdioRecord().id, first.id, "same canonical identity gets the same generated id");
		assert.notEqual(stdioRecord("global-user").id, first.id, "scope participates in identity");

		const project = createAdoptedExtension({
			kind: "skills", scope: "project", projectId: "p-1", source: { directory: path.join(tempDir, "skills") }, now: NOW,
		});
		const global = createAdoptedExtension({
			kind: "skills", scope: "global-user", source: { directory: path.join(tempDir, "global") }, now: NOW,
		});
		assert.deepEqual(
			aggregateAdoptedExtensions({ server: { [first.id]: first }, "global-user": { [global.id]: global }, project: { [project.id]: project } }, "p-1").map(record => record.scope),
			["server", "global-user", "project"],
		);
		assert.equal(aggregateAdoptedExtensions({ project: { [project.id]: project } }, "other").length, 0);
	});

	it("rejects secret-bearing transport channels and never exposes command arguments", () => {
		for (const source of [
			{ transport: "stdio", command: "node", env: { TOKEN: "secret" } },
			{ transport: "stdio", command: "node", cwd: "/private" },
			{ transport: "http", url: "https://user:pass@example.test/mcp" },
			{ transport: "http", url: "https://example.test/mcp?token=secret" },
			{ transport: "http", url: "https://example.test/mcp#secret" },
			{ transport: "http", url: "https://example.test/mcp", headers: { Authorization: "secret" } },
		]) {
			expect(() => createAdoptedExtension({ kind: "mcp", scope: "server", source, now: NOW })).toThrow(AdoptionValidationError);
		}
		const record = stdioRecord();
		const wire = redactAdoptedExtension(record);
		assert.deepEqual(wire.source, { transport: "stdio", command: "node" });
		assert.equal(JSON.stringify(wire).includes("--token=secret"), false);
		const contribution = adoptedMcpContribution({ ...record, operations: [{ name: "read", classification: "read-only-hint", selected: true }] });
		assert.deepEqual(contribution?.selectedOperations, ["read"]);
		assert.equal(contribution?.serverName, `adopt_${record.id}`);
		assert.equal(contribution?.runtimeServerKey, `adopt:server:${record.id}`);
	});

	it("fails closed for malformed hints and only auto-selects the initial read-only baseline", () => {
		assert.equal(classifyAdoptionMcpHints({ readOnlyHint: "true" }), "unknown");
		assert.equal(classifyAdoptionMcpHints({ readOnlyHint: true, destructiveHint: "false" }), "unknown");
		assert.equal(classifyAdoptionMcpHints({ readOnlyHint: true, destructiveHint: true }), "mutation-or-contradictory");
		const initial = reconcileAdoptionOperations([], [
			{ name: "read", annotations: { readOnlyHint: true } },
			{ name: "unknown", annotations: {} },
		], true);
		assert.deepEqual(initial.map(({ name, selected }) => ({ name, selected })), [{ name: "read", selected: true }, { name: "unknown", selected: false }]);
		const refreshed = reconcileAdoptionOperations(initial, [
			{ name: "read", annotations: { readOnlyHint: false } },
			{ name: "new-read", annotations: { readOnlyHint: true } },
		], false);
		assert.deepEqual(refreshed.map(({ name, selected }) => ({ name, selected })), [{ name: "read", selected: false }, { name: "new-read", selected: false }]);
		const explicit = reconcileAdoptionOperations([{ ...initial[0]!, selected: true, selection: "explicit" }], [{ name: "read", annotations: { destructiveHint: true } }], false);
		assert.equal(explicit[0]?.selected, true, "explicit operator choices remain subject to normal policy confirmation");
	});

	it("compare-and-swap prevents stale refreshes from resurrecting a deletion or clobbering a mutation", () => {
		const record = stdioRecord();
		const store = new ProjectConfigStore(tempDir);
		store.upsertAdoptedExtension("server", record);
		const stale = store.getAdoptedExtensions("server")[record.id]!;
		const disabled = { ...stale, revision: nextAdoptedExtensionRevision(stale), enabled: false, provenance: { ...stale.provenance, updatedAt: "2026-01-02T03:04:06.000Z" } };
		assert.equal(store.compareAndSwapAdoptedExtension("server", record.id, stale.revision, disabled), "updated");
		const staleRefresh = { ...stale, revision: nextAdoptedExtensionRevision(stale), conformance: { ...stale.conformance, checkedAt: "2026-01-02T03:04:07.000Z" }, provenance: { ...stale.provenance, updatedAt: "2026-01-02T03:04:07.000Z" } };
		assert.equal(store.compareAndSwapAdoptedExtension("server", record.id, stale.revision, staleRefresh), "conflict");
		assert.equal(store.removeAdoptedExtension("server", record.id), true);
		assert.equal(store.compareAndSwapAdoptedExtension("server", record.id, stale.revision, staleRefresh), "missing");
	});

	it("drops malformed persisted records independently and round-trips/removes a healthy record", () => {
		const healthy = stdioRecord();
		fs.writeFileSync(configFile(), yaml.stringify({
			adopted_extensions: {
				server: {
					[healthy.id]: healthy,
					unsafe: {
						...healthy,
						id: "unsafe",
						namespace: "adopt_unsafe",
						source: { transport: "stdio", command: "node", env: { TOKEN: "must-not-load" } },
					},
				},
			},
		}));
		const store = new ProjectConfigStore(tempDir);
		const loaded = store.getAdoptedExtensions("server") as Record<string, ReturnType<typeof stdioRecord>>;
		assert.deepEqual(Object.keys(loaded), [healthy.id]);
		assert.deepEqual(store.getAdoptionWarnings(), [{ code: "invalid_adoption_record", scope: "server", id: "unsafe" }]);

		store.upsertAdoptedExtension("server", healthy);
		const onDisk = fs.readFileSync(configFile(), "utf-8");
		assert.equal(JSON.stringify(store.getAll()).includes("--token=secret"), false, "legacy wire-shaped config view is redacted");
		assert.equal(onDisk.includes("TOKEN"), false);
		assert.equal(onDisk.includes("--token=secret"), true, "stdio arguments are durable but intentionally absent from wire helpers");
		assert.equal(new ProjectConfigStore(tempDir).removeAdoptedExtension("server", healthy.id), true);
		assert.deepEqual(new ProjectConfigStore(tempDir).getAdoptedExtensions("server"), {});
	});
});
