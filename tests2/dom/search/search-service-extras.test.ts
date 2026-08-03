import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SearchService } from "../../../src/server/search/search-service.ts";
import { ProgressBus } from "../../../src/server/search/progress-bus.ts";

function tmp(prefix = "search-service-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitForResult(service: SearchService, token: string): Promise<void> {
	await expect.poll(async () => (await service.search(token, { type: "messages" })).results.length, { timeout: 5_000 }).toBe(1);
}

test("open is ready without starting search work until an operation needs it", async () => {
	const stateDir = tmp();
	const service = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
	try {
		service.open();
		await service.whenReady();
		expect(service.getState()).toBe("ready");
		expect(fs.existsSync(service.dataDir)).toBe(false);

		await service.search("no corpus yet");
		expect(fs.existsSync(service.dataDir)).toBe(true);
	} finally {
		await service.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("search results remain correct after a service restart from the durable mirror", async () => {
	const stateDir = tmp();
	const token = "RestartMirrorSearchToken";
	const first = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
	try {
		first.open();
		await first.whenReady();
		first.indexMessage("s1", "Restart session", `message containing ${token}`, [], 123, "p1");
		await waitForResult(first, token);
		await first.close();

		const second = new SearchService({ stateDir, projectId: "p1", progressBus: new ProgressBus() });
		try {
			second.open();
			await second.whenReady();
			await waitForResult(second, token);
		} finally {
			await second.close();
		}
	} finally {
		if (first.getState() !== "closed") await first.close();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a saturated worker ingest queue drops derived updates without blocking message handling", async () => {
	const service = new SearchService({ stateDir: tmp(), projectId: "p1" });
	const internals = service as unknown as {
		_call(command: string, payload?: unknown): Promise<unknown>;
		_pendingMutations: number;
	};
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	internals._call = () => blocked;
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
	try {
		const startedAt = Date.now();
		for (let i = 0; i < 1_001; i++) {
			service.indexMessage("s1", "Busy session", `bounded ingest ${i}`, [], i, "p1");
		}
		expect(Date.now() - startedAt).toBeLessThan(250);
		expect(internals._pendingMutations).toBeLessThanOrEqual(1_000);
		expect(warnings.some((line) => line.includes("ingest backlog saturated"))).toBe(true);
	} finally {
		console.warn = originalWarn;
		release();
		await service.close();
		fs.rmSync(service.stateDir, { recursive: true, force: true });
	}
});
