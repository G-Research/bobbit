/**
 * CON-02 regression tests: project.yaml (the highest-value user-authored
 * config — workflows, components, pack activation/order, build/test
 * commands) now:
 *
 *   1. writes via the shared atomic-json.ts discipline (tmp-write -> fsync ->
 *      rename -> dir fsync, BACKUP_COUNT-deep .bak.N rotation) instead of a
 *      plain truncating fs.writeFileSync — same mechanism CON-01 gave
 *      gate/team/task/inbox, generalized in atomic-json.ts's
 *      atomicWriteFileSync() so every durable store shares one
 *      write-discipline implementation regardless of on-disk format;
 *   2. never lets a corrupt-but-present file collapse into an empty
 *      in-memory state that a subsequent save() would then serialize back
 *      over it, permanently destroying it. load() first tries the newest
 *      parseable .bak.N; if none parses it sets a loadFailed flag instead,
 *      and save() refuses (throws) while that flag is set.
 *
 * Deterministic pre-fix repro (see docs/debugging.md): overwrite
 * project.yaml with invalid YAML, restart, call any setter -> file becomes
 * `{}`. These tests pin that this can no longer happen.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.js";
import { bakPath } from "../src/server/agent/atomic-json.js";
import { makeTmpDir } from "./helpers/tmp.ts";

let tmpDir: string;

function yamlPath(): string { return path.join(tmpDir, "project.yaml"); }
function readYaml(): Record<string, unknown> {
	return yaml.parse(fs.readFileSync(yamlPath(), "utf-8")) as Record<string, unknown>;
}
function writeYaml(content: string) {
	fs.writeFileSync(yamlPath(), content);
}

describe("ProjectConfigStore — CON-02 atomic write + corrupt-file guard", () => {
	beforeEach(() => {
		tmpDir = makeTmpDir("pcs-atomic-");
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("normal writes", () => {
		it("rotates .bak.1 on the second save and leaves no stray .tmp", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.set("build_command", "npm run build:1");
			store.set("build_command", "npm run build:2"); // second save -> .bak.1 holds build:1 snapshot

			assert.ok(fs.existsSync(yamlPath()));
			assert.ok(!fs.existsSync(`${yamlPath()}.tmp`), "no stray .tmp after a successful save");
			assert.ok(fs.existsSync(bakPath(yamlPath(), 1)), ".bak.1 created on the second save");

			const bak = yaml.parse(fs.readFileSync(bakPath(yamlPath(), 1), "utf-8"));
			assert.equal(bak.build_command, "npm run build:1");
			assert.equal(readYaml().build_command, "npm run build:2");
		});

		it("a torn write (simulated kill mid-write) does not corrupt the prior good file, because rename is atomic", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.set("build_command", "npm run build:good");
			const before = fs.readFileSync(yamlPath(), "utf-8");

			// Simulate a kill-9 between the tmp write and rename.
			fs.writeFileSync(`${yamlPath()}.tmp`, ": not : valid : yaml : at : all", "utf-8");

			assert.equal(fs.readFileSync(yamlPath(), "utf-8"), before, "primary file unchanged by a torn .tmp write");
			const reloaded = new ProjectConfigStore(tmpDir);
			assert.equal(reloaded.get("build_command"), "npm run build:good");
			assert.equal(reloaded.isLoadFailed(), false);
		});
	});

	describe("fresh / missing / empty file", () => {
		it("missing file is a normal fresh init, not loadFailed — saves work", () => {
			assert.ok(!fs.existsSync(yamlPath()));
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.isLoadFailed(), false);
			assert.doesNotThrow(() => store.set("build_command", "npm run build"));
			assert.equal(new ProjectConfigStore(tmpDir).get("build_command"), "npm run build");
		});

		it("present-but-empty file is treated as an intentional reset, not corruption", () => {
			writeYaml("");
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.isLoadFailed(), false);
			assert.deepEqual(store.getAll(), {});
			assert.doesNotThrow(() => store.set("build_command", "npm run build"));
		});

		it("an empty file does NOT resurrect old content from a .bak.N (respects the reset intent)", () => {
			const store1 = new ProjectConfigStore(tmpDir);
			store1.set("build_command", "npm run build:old");
			store1.set("build_command", "npm run build:old2"); // rotates .bak.1 <- build:old
			assert.ok(fs.existsSync(bakPath(yamlPath(), 1)), "precondition: a backup exists");

			writeYaml(""); // user intentionally empties the file
			const store2 = new ProjectConfigStore(tmpDir);
			assert.equal(store2.isLoadFailed(), false);
			assert.equal(store2.get("build_command"), undefined, "must NOT resurrect from .bak.1");
		});
	});

	describe("corrupt primary, no recoverable backup — the CON-02 core scenario", () => {
		it("load() surfaces isLoadFailed() instead of silently starting empty", () => {
			writeYaml(":\n:\n"); // invalid YAML, matches the finding's repro
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.isLoadFailed(), true);
		});

		it("a setter throws instead of silently overwriting the corrupt file with empty defaults", () => {
			writeYaml(":\n:\n");
			const store = new ProjectConfigStore(tmpDir);

			const before = fs.readFileSync(yamlPath(), "utf-8");
			assert.throws(() => store.set("build_command", "npm run build"), /refusing to save/i);
			assert.equal(fs.readFileSync(yamlPath(), "utf-8"), before, "corrupt file must be untouched by the failed save attempt");
		});

		it("every setter kind refuses while loadFailed — components/workflows/pack activation included", () => {
			writeYaml(":\n:\n");
			const store = new ProjectConfigStore(tmpDir);
			assert.throws(() => store.setComponents([{ name: "a", repo: "." }]));
			assert.throws(() => store.setWorkflows({}));
			assert.throws(() => store.setConfigDirectories([{ path: "/a", types: ["skills"] }]));
			assert.throws(() => store.setSandboxTokens([{ key: "X", enabled: true }]));
			assert.throws(() => store.setPackOrder("project", ["a"]));
			assert.throws(() => store.setPackActivation("project", "p", { tools: ["t"] }));
			assert.throws(() => store.remove("build_command"));
		});

		it("a wrong-shape (non-object) parseable YAML document is also treated as loadFailed, not silently empty", () => {
			writeYaml("- just\n- a\n- list\n"); // parses fine, but isn't a plain object
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.isLoadFailed(), true);
			assert.throws(() => store.set("build_command", "x"));
		});
	});

	describe("corrupt primary WITH a parseable backup — recovers, saves resume", () => {
		it("recovers flat config from .bak.1 and clears loadFailed", () => {
			const store1 = new ProjectConfigStore(tmpDir);
			store1.set("build_command", "npm run build:v1");
			store1.set("build_command", "npm run build:v2"); // rotates .bak.1 <- v1

			writeYaml(":\n:\n"); // corrupt the primary in place

			const store2 = new ProjectConfigStore(tmpDir);
			assert.equal(store2.isLoadFailed(), false, "recovered from backup, not a failure state");
			assert.equal(store2.get("build_command"), "npm run build:v1", "recovered the most recent valid backup");
		});

		it("save() resumes after recovery: the corrupt primary is rotated into .bak.1 (never overwritten blind), and the recovered backup survives as .bak.2", () => {
			const store1 = new ProjectConfigStore(tmpDir);
			store1.set("build_command", "npm run build:v1");
			store1.set("build_command", "npm run build:v2"); // .bak.1 <- v1

			const corrupt = ":\n:\n";
			writeYaml(corrupt);

			const store2 = new ProjectConfigStore(tmpDir);
			assert.equal(store2.get("build_command"), "npm run build:v1");

			store2.set("test_command", "npm test"); // triggers a save() — should NOT throw
			assert.equal(store2.isLoadFailed(), false);

			// Primary now holds the fresh, good state.
			const primary = readYaml();
			assert.equal(primary.build_command, "npm run build:v1");
			assert.equal(primary.test_command, "npm test");

			// The corrupt primary got rotated into .bak.1 before being overwritten
			// (rotateBackups always copies the current file first) — never
			// destroyed blind.
			assert.equal(fs.readFileSync(bakPath(yamlPath(), 1), "utf-8"), corrupt);

			// The backup we actually recovered from is still present one
			// generation back.
			const bak2 = yaml.parse(fs.readFileSync(bakPath(yamlPath(), 2), "utf-8"));
			assert.equal(bak2.build_command, "npm run build:v1");
		});

		it("falls through to the second backup when the first is also corrupt", () => {
			const store1 = new ProjectConfigStore(tmpDir);
			store1.set("build_command", "npm run build:v1"); // becomes .bak.2 eventually
			store1.set("build_command", "npm run build:v2"); // .bak.1 <- v1
			store1.set("build_command", "npm run build:v3"); // .bak.2 <- v1, .bak.1 <- v2

			writeYaml(":\n:\n");
			fs.writeFileSync(bakPath(yamlPath(), 1), ":\n:\n", "utf-8");

			const store2 = new ProjectConfigStore(tmpDir);
			assert.equal(store2.isLoadFailed(), false);
			assert.equal(store2.get("build_command"), "npm run build:v1", "skipped corrupt primary AND corrupt .bak.1, landed on valid .bak.2");
		});
	});

	describe("missing primary with backup history", () => {
		it("missing primary + a parseable .bak.N recovers instead of starting fresh", () => {
			const store1 = new ProjectConfigStore(tmpDir);
			store1.set("build_command", "npm run build:v1");
			store1.set("build_command", "npm run build:v2"); // rotates .bak.1 <- v1
			assert.ok(fs.existsSync(bakPath(yamlPath(), 1)));

			fs.unlinkSync(yamlPath()); // primary accidentally deleted, backups remain

			const store2 = new ProjectConfigStore(tmpDir);
			assert.equal(store2.isLoadFailed(), false);
			assert.equal(store2.get("build_command"), "npm run build:v1");
		});

		it("missing primary + only corrupt .bak.N generations -> loadFailed (not silently fresh)", () => {
			const store1 = new ProjectConfigStore(tmpDir);
			store1.set("build_command", "npm run build:v1");
			assert.ok(fs.existsSync(yamlPath()));

			fs.unlinkSync(yamlPath());
			fs.writeFileSync(bakPath(yamlPath(), 1), ":\n:\n", "utf-8"); // corrupt the only backup

			const store2 = new ProjectConfigStore(tmpDir);
			assert.equal(store2.isLoadFailed(), true);
			assert.throws(() => store2.set("build_command", "x"));
		});
	});

	describe("reload() re-evaluates loadFailed", () => {
		it("a live reload() against an out-of-band-corrupted primary recovers from .bak.1 when one exists", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.set("build_command", "npm run build:live");
			store.setPackOrder("project", ["pack-a", "pack-b"]); // save 2 -> .bak.1 has build:live

			writeYaml(":\n:\n"); // file corrupted out-of-band while server is live
			store.reload();

			assert.equal(store.isLoadFailed(), false, "parseable .bak.1 exists — recovered, not failed");
			assert.equal(store.get("build_command"), "npm run build:live");
		});

		it("a failed live reload() (no parseable backup) keeps the full prior in-memory snapshot (flat keys AND migrated side-tables), reads stay consistent", () => {
			const store = new ProjectConfigStore(tmpDir);
			store.set("build_command", "npm run build:live");
			store.setPackOrder("project", ["pack-a", "pack-b"]);
			store.setConfigDirectories([{ path: "/shared", types: ["skills"] }]);

			// Corrupt the primary AND every backup generation out-of-band, so the
			// reload cannot recover from anywhere.
			writeYaml(":\n:\n");
			for (let i = 1; i <= 3; i++) {
				if (fs.existsSync(bakPath(yamlPath(), i))) fs.writeFileSync(bakPath(yamlPath(), i), ":\n:\n", "utf-8");
			}
			// getWithDefaults() triggers an internal re-read from disk.
			const withDefaults = store.getWithDefaults();

			assert.equal(store.isLoadFailed(), true);
			// The last known-good snapshot must survive intact — no half-reset
			// where flat keys persist but migrated side-tables get wiped.
			assert.equal(withDefaults.build_command, "npm run build:live");
			assert.deepEqual(store.getPackOrder("project"), ["pack-a", "pack-b"]);
			assert.deepEqual(store.getConfigDirectories(), [{ path: "/shared", types: ["skills"] }]);
			// But saves still refuse until the file is fixed.
			assert.throws(() => store.set("test_command", "npm test"));
		});

		it("fixing the file by hand and calling reload() clears loadFailed and re-enables saves", () => {
			writeYaml(":\n:\n");
			const store = new ProjectConfigStore(tmpDir);
			assert.equal(store.isLoadFailed(), true);

			// Fix it by hand (simulating manual operator recovery).
			writeYaml(yaml.stringify({ build_command: "npm run build:fixed" }));
			store.reload();
			assert.equal(store.isLoadFailed(), false);
			assert.equal(store.get("build_command"), "npm run build:fixed");
			assert.doesNotThrow(() => store.set("test_command", "npm test"));
		});
	});
});
