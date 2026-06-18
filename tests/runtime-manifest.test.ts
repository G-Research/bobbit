/**
 * Unit — P1 runtime manifest parser/validator (PURE).
 *
 * Covers:
 *   - required id + composeFile, safe id, env/secrets/ports/modes validation;
 *   - compose-path escape rejection (resolve relative to manifest file, contain
 *     within pack root) — the explicit P1 security requirement;
 *   - YAML parse tolerance (malformed → null + recorded problem).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
	parseRuntimeManifest,
	validateRuntimeManifest,
	resolveContainedComposePath,
	isSafeRuntimeId,
} from "../src/server/runtime/manifest.ts";

const PACK_ROOT = path.resolve("/packs/hindsight");
const SRC = path.join(PACK_ROOT, "runtimes", "hindsight.yaml");

describe("isSafeRuntimeId", () => {
	it("accepts dotted/dashed lowercase ids", () => {
		for (const id of ["hindsight", "managed-postgres", "a.b_c-1", "X9"]) {
			assert.equal(isSafeRuntimeId(id), true, id);
		}
	});
	it("rejects empty / unsafe ids", () => {
		for (const id of ["", "-leading", ".dot", "has space", "a/b", "..", 1, null, undefined]) {
			assert.equal(isSafeRuntimeId(id as unknown), false, String(id));
		}
	});
});

describe("resolveContainedComposePath", () => {
	it("resolves a contained path relative to the manifest dir", () => {
		const abs = resolveContainedComposePath("../runtime/compose.yaml", SRC, PACK_ROOT);
		assert.equal(abs, path.join(PACK_ROOT, "runtime", "compose.yaml"));
	});
	it("rejects escapes above the pack root", () => {
		assert.equal(resolveContainedComposePath("../../escape.yaml", SRC, PACK_ROOT), null);
		assert.equal(resolveContainedComposePath("../../../etc/passwd", SRC, PACK_ROOT), null);
	});
	it("rejects absolute and drive-absolute compose paths", () => {
		assert.equal(resolveContainedComposePath("/etc/passwd", SRC, PACK_ROOT), null);
		assert.equal(resolveContainedComposePath("C:\\win\\compose.yaml", SRC, PACK_ROOT), null);
		assert.equal(resolveContainedComposePath("\\leading", SRC, PACK_ROOT), null);
	});
});

describe("validateRuntimeManifest", () => {
	const base = { id: "hindsight", composeFile: "../runtime/compose.yaml" };

	it("accepts a minimal valid manifest", () => {
		const problems: string[] = [];
		const m = validateRuntimeManifest(base, SRC, PACK_ROOT, problems);
		assert.ok(m, problems.join("; "));
		assert.equal(m!.id, "hindsight");
		assert.equal(m!.composeFile, "../runtime/compose.yaml");
	});

	it("rejects a missing/invalid id", () => {
		const p: string[] = [];
		assert.equal(validateRuntimeManifest({ composeFile: "../runtime/compose.yaml" }, SRC, PACK_ROOT, p), null);
		assert.match(p.join("; "), /id/);
		assert.equal(validateRuntimeManifest({ id: "bad id", composeFile: "x.yaml" }, SRC, PACK_ROOT), null);
	});

	it("rejects a missing composeFile", () => {
		const p: string[] = [];
		assert.equal(validateRuntimeManifest({ id: "hindsight" }, SRC, PACK_ROOT, p), null);
		assert.match(p.join("; "), /composeFile/);
	});

	it("rejects a composeFile that escapes the pack root", () => {
		const p: string[] = [];
		assert.equal(
			validateRuntimeManifest({ id: "hindsight", composeFile: "../../../../etc/passwd" }, SRC, PACK_ROOT, p),
			null,
		);
		assert.match(p.join("; "), /escapes the pack root|unsafe/);
	});

	it("validates env literals and refs", () => {
		const m = validateRuntimeManifest(
			{
				...base,
				env: {
					LITERAL: "value",
					NUM: 5,
					FROM_SECRET: { secret: "user.key" },
					FROM_GEN: { generate: "gen.key" },
					FROM_PORT: { port: "api.port" },
				},
			},
			SRC,
			PACK_ROOT,
		);
		assert.ok(m);
		assert.equal(m!.env!.LITERAL, "value");
		assert.equal(m!.env!.NUM, "5");
		assert.deepEqual(m!.env!.FROM_SECRET, { secret: "user.key" });
		assert.deepEqual(m!.env!.FROM_PORT, { port: "api.port" });
	});

	it("rejects an env ref with multiple keys or invalid names", () => {
		assert.equal(
			validateRuntimeManifest({ ...base, env: { X: { secret: "a", port: "b" } } }, SRC, PACK_ROOT),
			null,
		);
		assert.equal(validateRuntimeManifest({ ...base, env: { "bad-name": "v" } }, SRC, PACK_ROOT), null);
		assert.equal(validateRuntimeManifest({ ...base, env: { X: {} } }, SRC, PACK_ROOT), null);
	});

	it("validates secrets and ports with dedupe", () => {
		const m = validateRuntimeManifest(
			{
				...base,
				secrets: [{ key: "gen.key", generate: true, env: "SECRET_ENV" }, { key: "user.key" }],
				ports: [{ key: "api.port", env: "API_PORT", container: 8080 }],
			},
			SRC,
			PACK_ROOT,
		);
		assert.ok(m);
		assert.equal(m!.secrets!.length, 2);
		assert.equal(m!.ports![0].container, 8080);

		assert.equal(
			validateRuntimeManifest({ ...base, secrets: [{ key: "dup" }, { key: "dup" }] }, SRC, PACK_ROOT),
			null,
		);
		assert.equal(
			validateRuntimeManifest({ ...base, ports: [{ key: "p", container: 99999 }] }, SRC, PACK_ROOT),
			null,
		);
	});

	it("validates modes including omitServices and requireEnv", () => {
		const m = validateRuntimeManifest(
			{
				...base,
				modes: {
					"managed-postgres": { services: ["api", "web", "db"] },
					"external-postgres": {
						services: ["api", "web", "db"],
						omitServices: ["db"],
						requireEnv: ["HINDSIGHT_API_DATABASE_URL"],
						env: { HINDSIGHT_API_DATABASE_URL: "${databaseUrl}" },
					},
				},
			},
			SRC,
			PACK_ROOT,
		);
		assert.ok(m);
		assert.deepEqual(m!.modes!["external-postgres"].omitServices, ["db"]);
		assert.deepEqual(m!.modes!["managed-postgres"].services, ["api", "web", "db"]);
	});

	it("rejects a non-mapping manifest", () => {
		assert.equal(validateRuntimeManifest(null, SRC, PACK_ROOT), null);
		assert.equal(validateRuntimeManifest([1, 2], SRC, PACK_ROOT), null);
		assert.equal(validateRuntimeManifest("x", SRC, PACK_ROOT), null);
	});
});

describe("parseRuntimeManifest", () => {
	it("parses valid YAML", () => {
		const yaml = [
			"id: hindsight",
			"title: Hindsight",
			"composeFile: ../runtime/compose.yaml",
			"modes:",
			"  managed-postgres:",
			"    services: [api, web, db]",
		].join("\n");
		const m = parseRuntimeManifest(yaml, SRC, PACK_ROOT);
		assert.ok(m);
		assert.equal(m!.title, "Hindsight");
	});

	it("returns null + records problem on malformed YAML", () => {
		const p: string[] = [];
		const m = parseRuntimeManifest("id: [unterminated", SRC, PACK_ROOT, p);
		assert.equal(m, null);
		assert.ok(p.length > 0);
	});

	it("returns null on a YAML compose-path escape", () => {
		const yaml = "id: hindsight\ncomposeFile: ../../../../etc/passwd\n";
		assert.equal(parseRuntimeManifest(yaml, SRC, PACK_ROOT), null);
	});
});
