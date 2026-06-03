/**
 * Unit tests for the round-7 server-side marketplace review fixes:
 *  1. HIGH — an `overwrite` install supersedes another pack's provenance for the
 *     same entity: ownership transfers to the installing pack, the prior pack's
 *     record drops that entity (and is removed entirely if emptied), so
 *     uninstall stays symmetric (uninstalling the prior pack never deletes an
 *     entity it no longer owns).
 *  2. HIGH — sync-error redaction routes through the shared `redactGitUrl`, so a
 *     `?token=`/`#token=` credential in a git url can't leak into lastSyncError
 *     (previously only userinfo was stripped).
 *  3. MED — a SUPPORTED contents key whose value is not an array makes the pack
 *     invalid, rather than being silently coerced to [].
 *  4. MED — role validation requires the YAML `name` to equal the declared
 *     entity name (the cascade resolution key).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeHarness, localSource, tmpDir } from "./helpers/marketplace-harness.ts";

const { scanPackDir, scanSource } = await import("../src/server/marketplace/pack-scanner.ts");
const { GitSourceBackend } = await import("../src/server/marketplace/sync-service.ts");
const { redactGitUrl } = await import("../src/server/marketplace/git-url-redact.ts");
import type { SourceRecord } from "../src/server/marketplace/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_B = path.join(__dirname, "fixtures", "marketplace", "source-b");

/** Write a pack declaring one role per supplied name; returns the pack dir. */
function writeRolePack(packId: string, roleNames: string[]): string {
	const dir = path.join(tmpDir("bobbit-market-pack-"), packId);
	fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
	const roleList = roleNames.map((n) => `    - ${n}`).join("\n");
	fs.writeFileSync(
		path.join(dir, "pack.yaml"),
		`apiVersion: 1\nid: ${packId}\nname: ${packId}\ndescription: test\nversion: 1.0.0\ncontents:\n  roles:\n${roleList}\n`,
	);
	for (const n of roleNames) {
		fs.writeFileSync(path.join(dir, "roles", `${n}.yaml`), `name: ${n}\nprompt: from ${packId}\n`);
	}
	return dir;
}

function gitSource(url: string): SourceRecord {
	return {
		id: "git-1", kind: "git", url, ref: null, path: null, label: "git",
		addedAt: 0, lastSyncedAt: null, lastSyncCommit: null, lastSyncError: null,
	};
}

// ── Fix 1: overwrite install supersedes another pack's provenance ────────────

describe("marketplace fix: overwrite install supersedes another pack's entity", () => {
	it("transfers ownership and removes an emptied prior record (uninstall stays symmetric)", () => {
		const h = makeHarness();
		const src = localSource();
		const roleDest = path.join(h.systemConfigDir, "roles", "shared.yaml");

		// Pack A installs the single role "shared".
		const dirA = writeRolePack("pack-a", ["shared"]);
		h.service.install({ scope: "system", projectId: null, source: src, pack: scanPackDir(src.id, dirA), entities: null, conflict: "fail" });
		assert.ok(h.systemProvenance().find(src.id, "pack-a"));
		assert.match(fs.readFileSync(roleDest, "utf-8"), /from pack-a/);

		// Pack B overwrites "shared".
		const dirB = writeRolePack("pack-b", ["shared"]);
		h.service.install({ scope: "system", projectId: null, source: src, pack: scanPackDir(src.id, dirB), entities: null, conflict: "overwrite" });
		assert.match(fs.readFileSync(roleDest, "utf-8"), /from pack-b/, "B's bytes won the overwrite");

		// A's record is emptied by the supersede → dropped entirely; B owns the entity.
		assert.equal(h.systemProvenance().find(src.id, "pack-a"), undefined, "emptied prior record removed");
		const recB = h.systemProvenance().find(src.id, "pack-b")!;
		assert.deepEqual(recB.entities.map((e) => e.name), ["shared"]);

		// Uninstalling A must NOT delete the entity it no longer owns.
		h.service.uninstall({ scope: "system", projectId: null, sourceId: src.id, packId: "pack-a" });
		assert.ok(fs.existsSync(roleDest), "B's file survives A's uninstall");

		// Uninstalling B (the real owner) removes it.
		h.service.uninstall({ scope: "system", projectId: null, sourceId: src.id, packId: "pack-b" });
		assert.ok(!fs.existsSync(roleDest), "owner uninstall removes the file");
	});

	it("keeps the prior record's other entities while dropping only the superseded one", () => {
		const h = makeHarness();
		const src = localSource();
		const uniqueDest = path.join(h.systemConfigDir, "roles", "only-a.yaml");
		const sharedDest = path.join(h.systemConfigDir, "roles", "shared.yaml");

		const dirA = writeRolePack("pack-a", ["only-a", "shared"]);
		h.service.install({ scope: "system", projectId: null, source: src, pack: scanPackDir(src.id, dirA), entities: null, conflict: "fail" });

		const dirB = writeRolePack("pack-b", ["shared"]);
		h.service.install({ scope: "system", projectId: null, source: src, pack: scanPackDir(src.id, dirB), entities: null, conflict: "overwrite" });

		const recA = h.systemProvenance().find(src.id, "pack-a")!;
		assert.deepEqual(recA.entities.map((e) => e.name).sort(), ["only-a"], "shared superseded, only-a retained");

		// Uninstall A removes only its own remaining entity; B's shared survives.
		h.service.uninstall({ scope: "system", projectId: null, sourceId: src.id, packId: "pack-a" });
		assert.ok(!fs.existsSync(uniqueDest), "A's unique entity removed");
		assert.ok(fs.existsSync(sharedDest), "B's shared entity survives");
	});
});

// ── Fix 2: sync-error redaction uses redactGitUrl ────────────────────────────

describe("marketplace fix: sync-error redaction strips query/fragment tokens", () => {
	it("redactGitUrl drops a ?token= query param", () => {
		assert.equal(redactGitUrl("https://github.com/acme/p.git?token=ghp_secret"), "https://github.com/acme/p.git");
	});

	it("does not leak a query-string token into lastSyncError on a failed clone", async () => {
		const backend = new GitSourceBackend();
		const cache = path.join(tmpDir("bobbit-market-cache-"), "clone");
		// A file:// url to a nonexistent repo fails fast (offline, no network),
		// and the failing argv carries the token verbatim into the error message.
		const url = `file:///no/such/marketplace-repo-xyz?token=ghp_secret`;
		const res = await backend.sync(gitSource(url), cache);
		assert.notEqual(res.error, null, "clone of a nonexistent repo fails");
		assert.ok(!res.error!.includes("ghp_secret"), `token leaked: ${res.error}`);
	});
});

// ── Fix 3: malformed supported contents key (non-array) → invalid ────────────

describe("marketplace fix: non-array supported contents key invalidates the pack", () => {
	it("rejects a pack whose `tools` contents value is a string", () => {
		const p = scanPackDir("src-b", path.join(SOURCE_B, "bad-contents-pack"));
		assert.equal(p.valid, false);
		assert.match(p.error ?? "", /tools: contents value must be an array/i);
	});

	it("keeps a valid sibling pack valid while invalidating the malformed one", () => {
		const packs = scanSource("src-b", SOURCE_B);
		assert.equal(packs.find((p) => p.packId === "bad-contents-pack")!.valid, false);
		assert.equal(packs.find((p) => p.packId === "good-pack")!.valid, true);
	});
});

// ── Fix 4: role YAML name must equal the declared entity name ─────────────────

describe("marketplace fix: role YAML name must match declared entity name", () => {
	it("rejects a role whose YAML name disagrees with the declared name", () => {
		const p = scanPackDir("src-b", path.join(SOURCE_B, "role-name-mismatch-pack"));
		assert.equal(p.valid, false);
		assert.match(p.error ?? "", /declares name "something-else" but must match entity name "mismatch"/i);
	});

	it("accepts a role whose YAML name matches the declared name", () => {
		const p = scanPackDir("src-b", path.join(SOURCE_B, "good-pack"));
		assert.equal(p.valid, true);
		assert.deepEqual(p.entities.map((e) => `${e.type}/${e.name}`), ["role/helper"]);
	});
});
