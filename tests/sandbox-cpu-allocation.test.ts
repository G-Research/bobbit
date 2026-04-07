import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert";
import { computeResourceLimits, getDockerResourceLimits, _resetDockerLimitsCache } from "../src/server/agent/project-sandbox.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

// ── computeResourceLimits (pure function) ──────────────────────────────────

describe("computeResourceLimits", () => {
	describe("CPU limits", () => {
		it("host=16, docker=4 → cpus=2", () => {
			const { cpus } = computeResourceLimits(16, 32 * 1024 ** 3, 4, 32 * 1024 ** 3);
			assert.strictEqual(cpus, 2); // min(16,4)=4, 4-2=2
		});

		it("host=16, docker=12 → cpus=10", () => {
			const { cpus } = computeResourceLimits(16, 32 * 1024 ** 3, 12, 32 * 1024 ** 3);
			assert.strictEqual(cpus, 10); // min(16,12)=12, 12-2=10
		});

		it("host=4, docker=8 → cpus=2 (host is lower)", () => {
			const { cpus } = computeResourceLimits(4, 32 * 1024 ** 3, 8, 32 * 1024 ** 3);
			assert.strictEqual(cpus, 2); // min(4,8)=4, 4-2=2
		});

		it("host=2, docker=2 → cpus=2 (floor)", () => {
			const { cpus } = computeResourceLimits(2, 32 * 1024 ** 3, 2, 32 * 1024 ** 3);
			assert.strictEqual(cpus, 2); // min(2,2)=2, 2-2=0, max(2,0)=2
		});

		it("host=3, docker=3 → cpus=2 (floor kicks in)", () => {
			const { cpus } = computeResourceLimits(3, 32 * 1024 ** 3, 3, 32 * 1024 ** 3);
			assert.strictEqual(cpus, 2); // min(3,3)=3, 3-2=1, max(2,1)=2
		});

		it("no docker limits → falls back to host-2", () => {
			const { cpus } = computeResourceLimits(16, 32 * 1024 ** 3);
			assert.strictEqual(cpus, 14); // 16-2=14
		});

		it("no docker limits, small host → floor at 2", () => {
			const { cpus } = computeResourceLimits(2, 32 * 1024 ** 3);
			assert.strictEqual(cpus, 2);
		});
	});

	describe("memory limits", () => {
		const GB = 1024 ** 3;

		it("host=32GB, docker=8GB → memoryGB=6", () => {
			const { memoryGB } = computeResourceLimits(16, 32 * GB, 16, 8 * GB);
			assert.strictEqual(memoryGB, 6); // min(32,8)=8, 8-2=6
		});

		it("host=8GB, docker=32GB → memoryGB=6 (host is lower)", () => {
			const { memoryGB } = computeResourceLimits(16, 8 * GB, 16, 32 * GB);
			assert.strictEqual(memoryGB, 6); // min(8,32)=8, 8-2=6
		});

		it("host=4GB, docker=4GB → memoryGB=4 (floor)", () => {
			const { memoryGB } = computeResourceLimits(16, 4 * GB, 16, 4 * GB);
			assert.strictEqual(memoryGB, 4); // min(4,4)=4, 4-2=2, max(4,2)=4
		});

		it("no docker limits → falls back to host-2", () => {
			const { memoryGB } = computeResourceLimits(16, 32 * GB);
			assert.strictEqual(memoryGB, 30); // 32-2=30
		});

		it("no docker limits, small host → floor at 4", () => {
			const { memoryGB } = computeResourceLimits(16, 4 * GB);
			assert.strictEqual(memoryGB, 4); // 4-2=2, max(4,2)=4
		});
	});

	describe("combined", () => {
		it("both CPU and memory constrained by Docker", () => {
			const GB = 1024 ** 3;
			const result = computeResourceLimits(16, 32 * GB, 4, 8 * GB);
			assert.strictEqual(result.cpus, 2);
			assert.strictEqual(result.memoryGB, 6);
		});
	});
});

// ── getDockerResourceLimits caching ────────────────────────────────────────

describe("getDockerResourceLimits", () => {
	beforeEach(() => {
		_resetDockerLimitsCache();
	});

	after(() => {
		_resetDockerLimitsCache();
	});

	it("caches the result across calls", async () => {
		// First call populates the cache, second returns cached value
		const result1 = await getDockerResourceLimits();
		const result2 = await getDockerResourceLimits();

		// Both calls return the same object reference (cached)
		assert.strictEqual(result1, result2);
	});

	it("returns an object with cpus and memBytes when Docker is available", async () => {
		// Check if Docker is available first
		try {
			await execFileAsync("docker", ["info", "--format", "{{.NCPU}}"], { timeout: 5_000 });
		} catch {
			// Docker not available — skip this test
			return;
		}

		const result = await getDockerResourceLimits();
		if (result === null) return; // Docker info failed unexpectedly

		assert.ok(typeof result.cpus === "number" && result.cpus > 0, `cpus should be positive, got ${result.cpus}`);
		assert.ok(typeof result.memBytes === "number" && result.memBytes > 0, `memBytes should be positive, got ${result.memBytes}`);
	});
});
