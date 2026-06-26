import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type MigrationOptions = { sourcePath: string; destinationPath: string; overwrite?: boolean };
type MigrationFn = (opts: MigrationOptions) => unknown | Promise<unknown>;

type MigrationReport = {
	copied?: unknown[];
	skipped?: unknown[];
	overwritten?: unknown[];
	missing?: unknown[];
	warnings?: unknown[];
	errors?: unknown[];
};

async function loadMigrationFn(): Promise<MigrationFn> {
	const candidates = [
		"../src/server/agent-dir-migration.ts",
		"../src/server/agent-dir-config.ts",
		"../src/server/bobbit-dir.ts",
	];
	const names = ["migrateAgentDirData", "copyMigrateAgentDir", "migrateAgentDir"];
	for (const specifier of candidates) {
		try {
			const mod = await import(specifier) as Record<string, any>;
			for (const name of names) {
				if (typeof mod[name] === "function") {
					return (opts) => callMigration(mod[name], opts);
				}
			}
		} catch (err: any) {
			if (err?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find module/.test(String(err?.message))) continue;
			throw err;
		}
	}
	throw new Error(`agent dir migration helper must export one of: ${names.join(", ")}`);
}

function callMigration(fn: Function, opts: MigrationOptions): unknown | Promise<unknown> {
	if (fn.length >= 2) return fn(opts.sourcePath, opts.destinationPath, opts.overwrite === true);
	return fn(opts);
}

function makeTree(): { root: string; source: string; dest: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-agent-dir-migration-"));
	const source = path.join(root, "source-agent");
	const dest = path.join(root, "dest-agent");
	fs.mkdirSync(path.join(source, "sessions", "session-a"), { recursive: true });
	fs.mkdirSync(path.join(source, "bin", "nested"), { recursive: true });
	fs.mkdirSync(path.join(source, "not-allowed-dir"), { recursive: true });
	fs.writeFileSync(path.join(source, "sessions", "session-a", "transcript.jsonl"), "session-source\n");
	fs.writeFileSync(path.join(source, "bin", "rg"), "rg-source");
	fs.writeFileSync(path.join(source, "bin", "nested", "fd"), "fd-source");
	for (const file of ["auth.json", "models.json", "settings.json", "google-code-assist.json"]) {
		fs.writeFileSync(path.join(source, file), `${file}-source`);
	}
	fs.writeFileSync(path.join(source, "secrets.txt"), "must-not-copy");
	fs.writeFileSync(path.join(source, "not-allowed-dir", "file.txt"), "must-not-copy");
	return { root, source, dest };
}

function cleanup(root: string): void {
	fs.rmSync(root, { recursive: true, force: true });
}

function read(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

function symlinkDirectory(target: string, linkPath: string): boolean {
	try {
		fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch {
		return false;
	}
}

function reportText(report: unknown): string {
	return JSON.stringify(report, (_key, value) => value instanceof Error ? value.message : value);
}

function reportBucket(report: unknown, bucket: keyof MigrationReport): string {
	const value = (report as MigrationReport)?.[bucket];
	return JSON.stringify(value ?? []);
}

describe("agent directory copy migration", () => {
	it("copies only allowlisted files/directories and preserves the source", async (t) => {
		const migrate = await loadMigrationFn();
		const { root, source, dest } = makeTree();
		t.after(() => cleanup(root));

		const report = await migrate({ sourcePath: source, destinationPath: dest, overwrite: false });
		assert.equal(fs.existsSync(source), true, "source directory must be preserved");
		assert.equal(read(path.join(source, "auth.json")), "auth.json-source", "source files must not be moved or deleted");

		assert.equal(read(path.join(dest, "sessions", "session-a", "transcript.jsonl")), "session-source\n");
		assert.equal(read(path.join(dest, "bin", "rg")), "rg-source");
		assert.equal(read(path.join(dest, "bin", "nested", "fd")), "fd-source");
		for (const file of ["auth.json", "models.json", "settings.json", "google-code-assist.json"]) {
			assert.equal(read(path.join(dest, file)), `${file}-source`);
		}
		assert.equal(fs.existsSync(path.join(dest, "secrets.txt")), false, "non-allowlisted root files must not be copied");
		assert.equal(fs.existsSync(path.join(dest, "not-allowed-dir")), false, "non-allowlisted directories must not be copied");
		assert.match(reportText(report), /sessions|auth\.json|models\.json|settings\.json|google-code-assist\.json|bin/);
	});

	it("skips existing destination files by default", async (t) => {
		const migrate = await loadMigrationFn();
		const { root, source, dest } = makeTree();
		t.after(() => cleanup(root));
		fs.mkdirSync(path.join(dest, "sessions", "session-a"), { recursive: true });
		fs.mkdirSync(path.join(dest, "bin"), { recursive: true });
		fs.writeFileSync(path.join(dest, "auth.json"), "auth-existing");
		fs.writeFileSync(path.join(dest, "sessions", "session-a", "transcript.jsonl"), "session-existing\n");
		fs.writeFileSync(path.join(dest, "bin", "rg"), "rg-existing");

		const report = await migrate({ sourcePath: source, destinationPath: dest, overwrite: false });

		assert.equal(read(path.join(dest, "auth.json")), "auth-existing");
		assert.equal(read(path.join(dest, "sessions", "session-a", "transcript.jsonl")), "session-existing\n");
		assert.equal(read(path.join(dest, "bin", "rg")), "rg-existing");
		assert.match(reportBucket(report, "skipped"), /auth\.json|transcript\.jsonl|rg/);
	});

	it("overwrites existing destination files only when overwrite is explicit", async (t) => {
		const migrate = await loadMigrationFn();
		const { root, source, dest } = makeTree();
		t.after(() => cleanup(root));
		fs.mkdirSync(path.join(dest, "sessions", "session-a"), { recursive: true });
		fs.mkdirSync(path.join(dest, "bin"), { recursive: true });
		fs.writeFileSync(path.join(dest, "auth.json"), "auth-existing");
		fs.writeFileSync(path.join(dest, "sessions", "session-a", "transcript.jsonl"), "session-existing\n");
		fs.writeFileSync(path.join(dest, "bin", "rg"), "rg-existing");

		const report = await migrate({ sourcePath: source, destinationPath: dest, overwrite: true });

		assert.equal(read(path.join(dest, "auth.json")), "auth.json-source");
		assert.equal(read(path.join(dest, "sessions", "session-a", "transcript.jsonl")), "session-source\n");
		assert.equal(read(path.join(dest, "bin", "rg")), "rg-source");
		assert.match(reportBucket(report, "overwritten"), /auth\.json|transcript\.jsonl|rg/);
	});

	it("reports missing allowlisted entries without creating placeholders", async (t) => {
		const migrate = await loadMigrationFn();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-agent-dir-migration-missing-"));
		const source = path.join(root, "source-agent");
		const dest = path.join(root, "dest-agent");
		t.after(() => cleanup(root));
		fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(source, "sessions", "only.jsonl"), "only");

		const report = await migrate({ sourcePath: source, destinationPath: dest, overwrite: false });

		assert.equal(read(path.join(dest, "sessions", "only.jsonl")), "only");
		assert.equal(fs.existsSync(path.join(dest, "auth.json")), false);
		assert.match(reportBucket(report, "missing"), /auth\.json|models\.json|settings\.json|google-code-assist\.json|bin/);
	});

	it("rejects same source and destination before copying", async (t) => {
		const migrate = await loadMigrationFn();
		const { root, source } = makeTree();
		t.after(() => cleanup(root));

		const report = await migrate({ sourcePath: source, destinationPath: source, overwrite: true });

		assert.match(reportText(report), /SAME_PATH|must be different/i);
		assert.equal(fs.existsSync(path.join(source, "auth.json")), true, "source is preserved");
	});

	it("rejects destination nested inside source before creating it", async (t) => {
		const migrate = await loadMigrationFn();
		const { root, source } = makeTree();
		t.after(() => cleanup(root));
		const nestedDest = path.join(source, "nested-destination");

		const report = await migrate({ sourcePath: source, destinationPath: nestedDest, overwrite: true });

		assert.match(reportText(report), /DESTINATION_INSIDE_SOURCE|destinationPath must not be inside sourcePath/i);
		assert.equal(fs.existsSync(nestedDest), false, "nested destination must not be created");
	});

	it("rejects destination symlinked to a source child before copying", async (t) => {
		const migrate = await loadMigrationFn();
		const { root, source, dest } = makeTree();
		t.after(() => cleanup(root));
		if (!symlinkDirectory(path.join(source, "sessions"), dest)) {
			t.skip("directory symlinks are unavailable on this platform");
			return;
		}

		const report = await migrate({ sourcePath: source, destinationPath: dest, overwrite: true });

		assert.match(reportText(report), /DESTINATION_INSIDE_SOURCE|destinationPath must not be inside sourcePath/i);
		assert.equal(fs.existsSync(path.join(source, "sessions", "auth.json")), false, "migration must not copy root files through the symlinked destination");
		assert.equal(fs.existsSync(path.join(source, "sessions", "sessions")), false, "migration must not recursively copy sessions through the symlinked destination");
	});

	it("refuses to copy through top-level destination allowlist directory symlinks", async (t) => {
		const migrate = await loadMigrationFn();
		const { root, source, dest } = makeTree();
		t.after(() => cleanup(root));
		const outside = path.join(root, "outside-target");
		fs.mkdirSync(dest, { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		if (!symlinkDirectory(outside, path.join(dest, "sessions"))) {
			t.skip("directory symlinks are unavailable on this platform");
			return;
		}

		const report = await migrate({ sourcePath: source, destinationPath: dest, overwrite: true });

		assert.match(reportText(report), /sessions.*symlink|symlink.*sessions/i);
		assert.equal(fs.existsSync(path.join(outside, "session-a", "transcript.jsonl")), false, "migration must not write through destination directory symlinks");
		assert.equal(read(path.join(dest, "auth.json")), "auth.json-source", "safe root files may still be copied into the selected destination");
	});

	it("rejects source nested inside destination before copying", async (t) => {
		const migrate = await loadMigrationFn();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-agent-dir-migration-nested-source-"));
		t.after(() => cleanup(root));
		const dest = path.join(root, "dest-agent");
		const source = path.join(dest, "nested-source");
		fs.mkdirSync(path.join(source, "sessions"), { recursive: true });
		fs.writeFileSync(path.join(source, "auth.json"), "nested auth");
		fs.writeFileSync(path.join(source, "sessions", "nested.jsonl"), "nested transcript");

		const report = await migrate({ sourcePath: source, destinationPath: dest, overwrite: true });

		assert.match(reportText(report), /SOURCE_INSIDE_DESTINATION|sourcePath must not be inside destinationPath/i);
		assert.equal(fs.existsSync(path.join(dest, "auth.json")), false, "migration must not copy files into the parent destination");
	});
});
