/**
 * Unit tests for SearchService — per-project path isolation and the
 * collapsed state machine after the FlexSearch migration.
 */
import { test, expect } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { SearchService } from "../../src/server/search/search-service.ts";
import { ProgressBus } from "../../src/server/search/progress-bus.ts";

test("dataDir is scoped to stateDir (search.flex subdirectory)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-path-"));
	const svc = new SearchService({ stateDir: dir, projectId: "p1" });
	expect(svc.dataDir).toBe(path.join(dir, "search.flex"));
});

test("two SearchService instances use different dataDirs", () => {
	const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "svc-a-"));
	const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "svc-b-"));
	const s1 = new SearchService({ stateDir: dir1, projectId: "p1" });
	const s2 = new SearchService({ stateDir: dir2, projectId: "p2" });
	expect(s1.dataDir).not.toBe(s2.dataDir);
});

test("state transitions initializing → ready → closed", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-state-"));
	const svc = new SearchService({
		stateDir,
		projectId: "p1",
		progressBus: new ProgressBus(),
	});
	expect(svc.getState()).toBe("initializing");
	svc.open();
	await svc.whenReady();
	expect(svc.getState()).toBe("ready");
	await svc.close();
	expect(svc.getState()).toBe("closed");
});

test("legacy search.lance directory is removed on open", async () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-lance-"));
	const lanceDir = path.join(stateDir, "search.lance");
	fs.mkdirSync(lanceDir, { recursive: true });
	fs.writeFileSync(path.join(lanceDir, "junk.txt"), "old data");

	const svc = new SearchService({
		stateDir,
		projectId: "p1",
		progressBus: new ProgressBus(),
	});
	svc.open();
	await svc.whenReady();
	try {
		expect(fs.existsSync(lanceDir)).toBe(false);
		// FlexSearch dataDir exists instead.
		expect(fs.existsSync(path.join(stateDir, "search.flex"))).toBe(true);
	} finally {
		await svc.close();
	}
});

test("getEngineInfo reports flexsearch", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "svc-engine-"));
	const svc = new SearchService({ stateDir: dir, projectId: "p1" });
	const info = svc.getEngineInfo();
	expect(info.engine).toBe("flexsearch");
	expect(typeof info.engineVersion).toBe("string");
	expect(info.engineVersion.length).toBeGreaterThan(0);
});
