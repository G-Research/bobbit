import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { rawApiFetch } from "./e2e-setup.js";

function bootTimingPath(bobbitDir: string): string {
	return join(bobbitDir, "state", "boot-timing.jsonl");
}

const SAMPLE = {
	reason: "post-snapshot-paint",
	isReload: true,
	total_ms: 512.3,
	route: "#/session/xyz",
	sessionId: "xyz",
	transcriptMessages: 17,
	marks: [
		{ name: "modules-evaluated", t: 210 },
		{ name: "first-paint", t: 260 },
		{ name: "post-snapshot-paint", t: 512.3 },
	],
};

test.describe("dev boot-timing API", () => {
	test.describe.configure({ mode: "serial" });

	test("rejects POST and GET outside the dev harness", async ({ gateway }) => {
		const previous = process.env.BOBBIT_DEV_HARNESS;
		const file = bootTimingPath(gateway.bobbitDir);
		try {
			rmSync(file, { force: true });
			delete process.env.BOBBIT_DEV_HARNESS;

			const post = await rawApiFetch("/api/dev/boot-timing", { method: "POST", body: JSON.stringify(SAMPLE) });
			expect(post.status).toBe(403);
			expect(await post.json()).toMatchObject({ error: expect.stringMatching(/dev harness/i) });

			const get = await rawApiFetch("/api/dev/boot-timing");
			expect(get.status).toBe(403);

			expect(existsSync(file)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.BOBBIT_DEV_HARNESS;
			else process.env.BOBBIT_DEV_HARNESS = previous;
		}
	});

	test("under the harness, appends a sample and reads it back", async ({ gateway }) => {
		const previous = process.env.BOBBIT_DEV_HARNESS;
		const file = bootTimingPath(gateway.bobbitDir);
		try {
			rmSync(file, { force: true });
			process.env.BOBBIT_DEV_HARNESS = "1";

			const post = await rawApiFetch("/api/dev/boot-timing", { method: "POST", body: JSON.stringify(SAMPLE) });
			expect(post.status).toBe(201);
			expect(await post.json()).toMatchObject({ ok: true, path: expect.stringContaining("boot-timing.jsonl") });

			// File on disk has exactly one JSONL row carrying the sample.
			expect(existsSync(file)).toBe(true);
			const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
			expect(lines.length).toBe(1);
			const stored = JSON.parse(lines[0]);
			expect(stored).toMatchObject({ sessionId: "xyz", transcriptMessages: 17 });
			expect(typeof stored.receivedAt).toBe("string");

			// GET returns the parsed sample (newest last).
			const get = await rawApiFetch("/api/dev/boot-timing?limit=10");
			expect(get.status).toBe(200);
			const body = await get.json();
			expect(Array.isArray(body.samples)).toBe(true);
			expect(body.samples.at(-1)).toMatchObject({ sessionId: "xyz" });
		} finally {
			if (previous === undefined) delete process.env.BOBBIT_DEV_HARNESS;
			else process.env.BOBBIT_DEV_HARNESS = previous;
		}
	});

	test("rejects a non-object sample with 422", async () => {
		const previous = process.env.BOBBIT_DEV_HARNESS;
		try {
			process.env.BOBBIT_DEV_HARNESS = "1";
			const post = await rawApiFetch("/api/dev/boot-timing", { method: "POST", body: JSON.stringify([1, 2, 3]) });
			expect(post.status).toBe(422);
			expect(await post.json()).toMatchObject({ error: expect.stringMatching(/rejected/i) });
		} finally {
			if (previous === undefined) delete process.env.BOBBIT_DEV_HARNESS;
			else process.env.BOBBIT_DEV_HARNESS = previous;
		}
	});
});
