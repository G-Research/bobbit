import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, rawApiFetch } from "./e2e-setup.js";

function restartSentinelPath(bobbitDir: string): string {
	return join(bobbitDir, "state", "gateway-restart");
}

async function readHarnessStatus(): Promise<{ restartAvailable: boolean }> {
	const resp = await apiFetch("/api/harness-status");
	expect(resp.status).toBe(200);
	return await resp.json();
}

test.describe("harness restart API", () => {
	test.describe.configure({ mode: "serial" });

	test("reports restart unavailable and rejects direct restart outside the dev harness", async ({ gateway }) => {
		const previous = process.env.BOBBIT_DEV_HARNESS;
		const sentinel = restartSentinelPath(gateway.bobbitDir);
		try {
			rmSync(sentinel, { force: true });
			delete process.env.BOBBIT_DEV_HARNESS;

			await expect(readHarnessStatus()).resolves.toEqual({ restartAvailable: false });

			const resp = await rawApiFetch("/api/harness/restart", {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(resp.status).toBe(403);
			expect(await resp.json()).toMatchObject({
				error: expect.stringMatching(/dev harness/i),
			});
			expect(existsSync(sentinel)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.BOBBIT_DEV_HARNESS;
			else process.env.BOBBIT_DEV_HARNESS = previous;
		}
	});

	test("reports restart available under the dev harness and touches the isolated sentinel", async ({ gateway }) => {
		const previous = process.env.BOBBIT_DEV_HARNESS;
		const sentinel = restartSentinelPath(gateway.bobbitDir);
		try {
			rmSync(sentinel, { force: true });
			process.env.BOBBIT_DEV_HARNESS = "1";

			await expect(readHarnessStatus()).resolves.toEqual({ restartAvailable: true });

			const firstResp = await rawApiFetch("/api/harness/restart", {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(firstResp.status).toBe(202);
			expect(await firstResp.json()).toMatchObject({ ok: true, restartRequested: true });
			expect(existsSync(sentinel)).toBe(true);
			const firstContent = readFileSync(sentinel, "utf-8").trim();
			const firstMtime = statSync(sentinel).mtimeMs;
			expect(Number(firstContent)).toBeGreaterThan(0);

			await expect.poll(() => Date.now(), { timeout: 1_000 }).toBeGreaterThan(Number(firstContent));
			const secondResp = await rawApiFetch("/api/harness/restart", {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(secondResp.status).toBe(202);
			expect(await secondResp.json()).toMatchObject({ ok: true, restartRequested: true });
			const secondContent = readFileSync(sentinel, "utf-8").trim();
			const secondMtime = statSync(sentinel).mtimeMs;
			expect(Number(secondContent)).toBeGreaterThanOrEqual(Number(firstContent));
			expect(secondMtime).toBeGreaterThanOrEqual(firstMtime);
			expect(secondContent === firstContent && secondMtime === firstMtime).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.BOBBIT_DEV_HARNESS;
			else process.env.BOBBIT_DEV_HARNESS = previous;
		}
	});
});
