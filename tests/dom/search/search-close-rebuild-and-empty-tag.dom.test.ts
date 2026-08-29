import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../../tests2/dom/_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SearchService } from "../../../src/server/search/search-service.ts";
import { ProgressBus } from "../../../src/server/search/progress-bus.ts";

function tmp(prefix = "search-close-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("closing an unused service leaves no worker-created search state", async () => {
	const stateDir = tmp();
	const service = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
	try {
		service.open();
		await service.whenReady();
		await service.close();
		expect(service.getState()).toBe("closed");
		expect(fs.existsSync(service.dataDir)).toBe(false);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("legacy native search state is removed by the worker while a usable mirror remains searchable", async () => {
	const stateDir = tmp();
	const legacyDir = path.join(stateDir, "search.lance");
	fs.mkdirSync(legacyDir, { recursive: true });
	fs.writeFileSync(path.join(legacyDir, "cache"), "derived data");
	const service = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
	try {
		const emptySources = { goalStore: { getAll: () => [] }, sessionStore: { getAll: () => [] }, staffStore: { getAll: () => [] } };
		service.open(emptySources as any);
		await service.whenReady();
		await expect(service.search("initializes worker")).rejects.toMatchObject({ code: "SEARCH_UNAVAILABLE", reason: "rebuilding" });
		await service.rebuildFromStores(emptySources.goalStore as any, emptySources.sessionStore as any, undefined, emptySources.staffStore as any);
		expect(fs.existsSync(legacyDir)).toBe(false);
	} finally {
		await service.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
