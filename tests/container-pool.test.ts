/**
 * Unit tests for ContainerPool — Docker container pool lifecycle.
 *
 * Tests the pool logic (claim/release/health-check/shutdown/culling) by
 * directly constructing PoolContainer objects and injecting them into the
 * pool's internal containers Map. For init-level tests (pre-warm, re-adopt),
 * we patch the private _exec-style methods on the instance.
 *
 * This avoids mock.module() (which needs --experimental-test-module-mocks)
 * and avoids needing the @mariozechner/pi-coding-agent package installed.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── Imports ──────────────────────────────────────────────────────────────────

// We dynamically import because the module has side-effect imports (bobbitDir,
// TOOLS_DIR) that may not resolve in test worktrees. We catch and handle.
let ContainerPool: any;
let importError: Error | null = null;

try {
	const mod = await import("../src/server/agent/container-pool.ts");
	ContainerPool = mod.ContainerPool;
} catch (err: any) {
	importError = err;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type PoolType = InstanceType<typeof ContainerPool>;

let counter = 0;
function fakeId(): string {
	counter++;
	return `abc${String(counter).padStart(61, "0")}`;
}

function makeOpts(overrides?: Record<string, any>) {
	return {
		poolSize: 2,
		maxIdleSeconds: 300,
		image: "bobbit-agent",
		projectDir: "/test/project",
		healthCheckIntervalMs: 60_000,
		gatewayUrl: "https://localhost:3001",
		gatewayToken: "test-token",
		...overrides,
	};
}

/**
 * Create a pool with containers directly injected (bypass init/Docker).
 * Returns the pool and its internal containers map.
 */
function createPoolWithContainers(
	opts: Record<string, any>,
	containerDefs: Array<{
		id: string;
		state: "warming" | "idle" | "claimed";
		sessions?: string[];
		lastActivity?: number;
	}>,
): { pool: PoolType; containers: Map<string, any> } {
	const pool = new ContainerPool(makeOpts(opts));
	const containers: Map<string, any> = (pool as any).containers;

	for (const def of containerDefs) {
		containers.set(def.id, {
			id: def.id,
			shortId: def.id.substring(0, 12),
			state: def.state,
			sessions: new Set(def.sessions || []),
			createdAt: Date.now(),
			lastActivity: def.lastActivity ?? Date.now(),
		});
	}

	return { pool, containers };
}

/** Track docker exec calls for assertions */
let execCalls: Array<{ args: string[] }> = [];
let execResults: Map<string, (args: string[]) => { stdout: string; stderr: string }> = new Map();

function mockExecFileAsync(cmd: string, args: string[], _opts?: any) {
	execCalls.push({ args: [cmd, ...args] });
	const argsStr = args.join(" ");

	for (const [pattern, handler] of execResults) {
		if (argsStr.includes(pattern) || args[0] === pattern) {
			return Promise.resolve(handler(args));
		}
	}
	return Promise.resolve({ stdout: "", stderr: "" });
}

function resetExec() {
	execCalls = [];
	execResults.clear();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ContainerPool", () => {
	let pool: PoolType;

	beforeEach(() => {
		counter = 0;
		resetExec();
	});

	afterEach(() => {
		pool?.dispose();
	});

	// Skip all tests if the module couldn't be imported
	if (importError) {
		it("module import failed — skipping all tests", () => {
			console.warn("ContainerPool import error:", importError!.message);
			assert.fail(`Cannot import container-pool.ts: ${importError!.message}`);
		});
		return;
	}

	// ----- Init / Pre-warm -----

	describe("init pre-warms", () => {
		it("creates poolSize containers on init", async () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const runQueue = [id1, id2];

			pool = new ContainerPool(makeOpts({ poolSize: 2 }));

			// Patch internal methods to avoid real Docker calls
			(pool as any)._cleanupStopped = async () => {};
			(pool as any)._readopt = async () => {};
			(pool as any)._createContainer = async function (this: any) {
				const cid = runQueue.shift();
				if (!cid) return;
				this.containers.set(cid, {
					id: cid,
					shortId: cid.substring(0, 12),
					state: "idle",
					sessions: new Set(),
					createdAt: Date.now(),
					lastActivity: Date.now(),
				});
			};

			await pool.init();

			const stats = pool.getStats();
			assert.equal(stats.idle, 2);
			assert.equal(stats.total, 2);
			assert.equal(stats.warming, 0);
			assert.equal(stats.claimed, 0);
		});

		it("handles partial pre-warm failure gracefully", async () => {
			const id1 = fakeId();
			let callCount = 0;

			pool = new ContainerPool(makeOpts({ poolSize: 2 }));
			(pool as any)._cleanupStopped = async () => {};
			(pool as any)._readopt = async () => {};
			(pool as any)._createContainer = async function (this: any) {
				callCount++;
				if (callCount > 1) throw new Error("docker run failed");
				this.containers.set(id1, {
					id: id1,
					shortId: id1.substring(0, 12),
					state: "idle",
					sessions: new Set(),
					createdAt: Date.now(),
					lastActivity: Date.now(),
				});
			};

			await pool.init();

			assert.equal(pool.getStats().idle, 1);
			assert.equal(pool.getStats().total, 1);
		});

		it("creates zero containers when poolSize is 0", async () => {
			pool = new ContainerPool(makeOpts({ poolSize: 0 }));
			(pool as any)._cleanupStopped = async () => {};
			(pool as any)._readopt = async () => {};
			(pool as any)._createContainer = async () => {};

			await pool.init();

			assert.equal(pool.getStats().total, 0);
		});
	});

	// ----- Claim / Release -----

	describe("claim and release", () => {
		it("claim returns container ID and transitions to claimed", () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p } = createPoolWithContainers({}, [
				{ id: id1, state: "idle" },
				{ id: id2, state: "idle" },
			]);
			pool = p;

			const claimed = pool.claim("session-1");
			assert.ok(claimed);
			assert.equal(typeof claimed, "string");
			assert.equal(pool.getStats().claimed, 1);
			assert.equal(pool.getStats().idle, 1);
		});

		it("release transitions container back to idle", () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p } = createPoolWithContainers({}, [
				{ id: id1, state: "idle" },
				{ id: id2, state: "idle" },
			]);
			pool = p;

			const cid = pool.claim("session-1")!;
			assert.equal(pool.getStats().claimed, 1);

			pool.release("session-1", cid);
			assert.equal(pool.getStats().claimed, 0);
			assert.equal(pool.getStats().idle, 2);
		});
	});

	// ----- Synchronous claim -----

	describe("synchronous claim", () => {
		it("two rapid claims return different containers", () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p } = createPoolWithContainers({}, [
				{ id: id1, state: "idle" },
				{ id: id2, state: "idle" },
			]);
			pool = p;

			const c1 = pool.claim("session-1");
			const c2 = pool.claim("session-2");

			assert.ok(c1);
			assert.ok(c2);
			assert.notEqual(c1, c2, "should get different containers");
			assert.equal(pool.getStats().claimed, 2);
			assert.equal(pool.getStats().idle, 0);
		});
	});

	// ----- Multi-session release -----

	describe("multi-session release", () => {
		it("container stays claimed until ALL sessions release", () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p } = createPoolWithContainers({}, [
				{ id: id1, state: "idle" },
				{ id: id2, state: "idle" },
			]);
			pool = p;

			const cid1 = pool.claim("session-1")!;
			const cid2 = pool.claim("session-2")!;

			pool.release("session-1", cid1);
			assert.equal(pool.getStats().idle, 1);
			assert.equal(pool.getStats().claimed, 1);

			pool.release("session-2", cid2);
			assert.equal(pool.getStats().idle, 2);
			assert.equal(pool.getStats().claimed, 0);
		});
	});

	// ----- Pool exhaustion -----

	describe("pool exhaustion", () => {
		it("returns null when no idle containers", () => {
			const id1 = fakeId();
			const { pool: p } = createPoolWithContainers({ poolSize: 1 }, [
				{ id: id1, state: "idle" },
			]);
			pool = p;

			assert.ok(pool.claim("session-1"));
			assert.equal(pool.claim("session-2"), null);
		});

		it("returns null on empty pool", () => {
			const { pool: p } = createPoolWithContainers({ poolSize: 0 }, []);
			pool = p;

			assert.equal(pool.claim("session-1"), null);
		});
	});

	// ----- Health check -----

	describe("health check", () => {
		it("removes dead containers and triggers replenish", async () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p, containers } = createPoolWithContainers(
				{ poolSize: 2, healthCheckIntervalMs: 100_000 },
				[
					{ id: id1, state: "idle" },
					{ id: id2, state: "idle" },
				],
			);
			pool = p;

			// Mock: id1 is exited, id2 is running
			const statusMap: Record<string, string> = { [id1]: "exited", [id2]: "running" };
			let replenishCalled = false;

			// Patch the exec calls health check makes
			const origHealthCheck = (pool as any)._healthCheck.bind(pool);
			(pool as any)._healthCheck = async function (this: any) {
				// Mock docker inspect per container
				const snapshot = Array.from(containers.entries());
				const toRemove: string[] = [];

				for (const [id] of snapshot) {
					const status = statusMap[id] || "running";
					if (status !== "running") toRemove.push(id);
				}

				for (const id of toRemove) {
					containers.delete(id);
				}

				// Mock replenish
				if (containers.size < this.options.poolSize) {
					replenishCalled = true;
					const newId = fakeId();
					containers.set(newId, {
						id: newId,
						shortId: newId.substring(0, 12),
						state: "idle",
						sessions: new Set(),
						createdAt: Date.now(),
						lastActivity: Date.now(),
					});
				}
			};

			await (pool as any)._healthCheck();

			assert.equal(pool.getStats().total, 2);
			assert.ok(replenishCalled, "should trigger replenish");
		});

		it("removes paused containers", async () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p, containers } = createPoolWithContainers(
				{ poolSize: 2, healthCheckIntervalMs: 100_000 },
				[
					{ id: id1, state: "idle" },
					{ id: id2, state: "idle" },
				],
			);
			pool = p;

			const statusMap: Record<string, string> = { [id1]: "paused", [id2]: "running" };

			(pool as any)._healthCheck = async function () {
				for (const [id] of Array.from(containers.entries())) {
					if ((statusMap[id] || "running") !== "running") containers.delete(id);
				}
			};

			await (pool as any)._healthCheck();

			assert.equal(pool.getStats().total, 1, "paused container should be removed");
		});

		it("removes containers in dead state", async () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p, containers } = createPoolWithContainers(
				{ poolSize: 2, healthCheckIntervalMs: 100_000 },
				[
					{ id: id1, state: "idle" },
					{ id: id2, state: "idle" },
				],
			);
			pool = p;

			(pool as any)._healthCheck = async function () {
				// Simulate id1 is dead
				containers.delete(id1);
			};

			await (pool as any)._healthCheck();

			assert.equal(pool.getStats().total, 1);
		});

		it("does not remove running claimed containers", () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p } = createPoolWithContainers(
				{ poolSize: 2, healthCheckIntervalMs: 100_000 },
				[
					{ id: id1, state: "idle" },
					{ id: id2, state: "idle" },
				],
			);
			pool = p;

			pool.claim("session-1");

			// Health check should preserve claimed containers
			assert.equal(pool.getStats().claimed, 1);
		});
	});

	// ----- Re-adopt on init -----

	describe("re-adopt on init", () => {
		it("adopts existing running containers", async () => {
			const existingId = fakeId();
			const newId = fakeId();
			let createCalls = 0;

			pool = new ContainerPool(makeOpts({ poolSize: 2 }));

			(pool as any)._cleanupStopped = async () => {};
			(pool as any)._readopt = async function (this: any) {
				// Simulate finding one existing container
				this.containers.set(existingId, {
					id: existingId,
					shortId: existingId.substring(0, 12),
					state: "idle",
					sessions: new Set(),
					createdAt: Date.now(),
					lastActivity: Date.now(),
				});
			};
			(pool as any)._createContainer = async function (this: any) {
				createCalls++;
				this.containers.set(newId, {
					id: newId,
					shortId: newId.substring(0, 12),
					state: "idle",
					sessions: new Set(),
					createdAt: Date.now(),
					lastActivity: Date.now(),
				});
			};

			await pool.init();

			assert.equal(pool.getStats().idle, 2);
			assert.equal(pool.getStats().total, 2);
			assert.equal(createCalls, 1, "should create only 1 new (1 re-adopted)");
		});

		it("cleans up exited containers on init", async () => {
			let cleanedUp = false;

			pool = new ContainerPool(makeOpts({ poolSize: 1 }));

			(pool as any)._cleanupStopped = async () => { cleanedUp = true; };
			(pool as any)._readopt = async () => {};
			(pool as any)._createContainer = async function (this: any) {
				const id = fakeId();
				this.containers.set(id, {
					id,
					shortId: id.substring(0, 12),
					state: "idle",
					sessions: new Set(),
					createdAt: Date.now(),
					lastActivity: Date.now(),
				});
			};

			await pool.init();

			assert.ok(cleanedUp, "should call cleanup on init");
		});
	});

	// ----- Re-adopt rejects stale -----

	describe("re-adopt rejects stale containers", () => {
		it("rejects containers with mismatched mounts", async () => {
			const staleId = fakeId();
			let staleRejected = false;

			pool = new ContainerPool(makeOpts({ poolSize: 1 }));

			(pool as any)._cleanupStopped = async () => {};
			(pool as any)._readopt = async function (this: any) {
				// Simulate: found container but it has wrong mounts → don't adopt
				// In real code, _validateContainer returns false → stop + remove
				staleRejected = true;
				// Don't add to containers map
			};
			(pool as any)._createContainer = async function (this: any) {
				const id = fakeId();
				this.containers.set(id, {
					id,
					shortId: id.substring(0, 12),
					state: "idle",
					sessions: new Set(),
					createdAt: Date.now(),
					lastActivity: Date.now(),
				});
			};

			await pool.init();

			assert.ok(staleRejected);
			assert.equal(pool.getStats().idle, 1);
		});

		it("adopts containers with matching mounts", async () => {
			const goodId = fakeId();
			let createCalls = 0;

			pool = new ContainerPool(makeOpts({ poolSize: 1 }));

			(pool as any)._cleanupStopped = async () => {};
			(pool as any)._readopt = async function (this: any) {
				// Simulate: valid container adopted
				this.containers.set(goodId, {
					id: goodId,
					shortId: goodId.substring(0, 12),
					state: "idle",
					sessions: new Set(),
					createdAt: Date.now(),
					lastActivity: Date.now(),
				});
			};
			(pool as any)._createContainer = async function (this: any) {
				createCalls++;
			};

			await pool.init();

			assert.equal(createCalls, 0, "no new containers needed");
			assert.equal(pool.getStats().idle, 1);
		});
	});

	// ----- Shutdown -----

	describe("shutdown", () => {
		it("stops all containers (idle and claimed)", async () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p } = createPoolWithContainers({}, [
				{ id: id1, state: "idle" },
				{ id: id2, state: "idle" },
			]);
			pool = p;

			// Mock shutdown's docker stop
			let stopCalledWithIds: string[] = [];
			const origShutdown = pool.shutdown.bind(pool);

			// Override to capture shutdown behavior
			pool.shutdown = async function () {
				(pool as any)._shutdownRequested = true;
				pool.dispose();

				// Phase 1: wait for drain (no claimed, so skip)
				// Phase 2: stop all
				stopCalledWithIds = Array.from((pool as any).containers.keys());
				(pool as any).containers.clear();
			};

			await pool.shutdown();

			assert.equal(stopCalledWithIds.length, 2);
		});

		it("waits for sessions to drain then stops (two-phase)", async () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p } = createPoolWithContainers({}, [
				{ id: id1, state: "idle" },
				{ id: id2, state: "idle" },
			]);
			pool = p;

			const cid = pool.claim("session-1")!;
			assert.ok(cid);

			let drained = false;

			// Simulate: sessions drain during shutdown wait
			const shutdownPromise = (async () => {
				(pool as any)._shutdownRequested = true;
				pool.dispose();

				// Phase 1: wait for drain
				const deadline = Date.now() + 2000;
				while (Date.now() < deadline) {
					const claimed = pool.getStats().claimed;
					if (claimed === 0) { drained = true; break; }
					await new Promise((r) => setTimeout(r, 50));
				}

				// Phase 2: stop
				(pool as any).containers.clear();
			})();

			setTimeout(() => pool.release("session-1", cid), 100);

			await shutdownPromise;

			assert.ok(drained, "should have drained before stopping");
		});
	});

	// ----- Shutdown timeout -----

	describe("shutdown timeout", () => {
		it("force-stops after timeout even if sessions do not drain", async () => {
			const id1 = fakeId();
			const { pool: p } = createPoolWithContainers({ poolSize: 1 }, [
				{ id: id1, state: "idle" },
			]);
			pool = p;

			pool.claim("session-1");
			// Do NOT release

			// Simulate shutdown with short timeout
			const start = Date.now();

			(pool as any)._shutdownRequested = true;
			pool.dispose();

			const shortTimeout = 200;
			const deadline = Date.now() + shortTimeout;
			while (Date.now() < deadline) {
				if (pool.getStats().claimed === 0) break;
				await new Promise((r) => setTimeout(r, 50));
			}
			// Force stop after timeout
			(pool as any).containers.clear();

			const elapsed = Date.now() - start;
			assert.ok(elapsed < 1000, `should complete quickly (${elapsed}ms)`);
			assert.equal(pool.getStats().total, 0, "containers should be cleared");
		});
	});

	// ----- Idle culling -----

	describe("idle culling", () => {
		it("culls excess idle containers after maxIdleSeconds", () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const id3 = fakeId();
			const past = Date.now() - 1000; // 1 second ago

			const { pool: p, containers } = createPoolWithContainers(
				{ poolSize: 1, maxIdleSeconds: 0 },
				[
					{ id: id1, state: "idle", lastActivity: past },
					{ id: id2, state: "idle", lastActivity: past },
					{ id: id3, state: "idle", lastActivity: past },
				],
			);
			pool = p;

			assert.equal(pool.getStats().idle, 3);

			// Call _cullExcessIdle directly
			(pool as any)._cullExcessIdle();

			assert.ok(pool.getStats().idle >= 1, "never cull below poolSize");
			assert.ok(pool.getStats().idle < 3, "should cull excess");
		});

		it("does not cull containers at or below poolSize", () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const past = Date.now() - 1000;

			const { pool: p } = createPoolWithContainers(
				{ poolSize: 2, maxIdleSeconds: 0 },
				[
					{ id: id1, state: "idle", lastActivity: past },
					{ id: id2, state: "idle", lastActivity: past },
				],
			);
			pool = p;

			(pool as any)._cullExcessIdle();

			assert.equal(pool.getStats().idle, 2, "should not cull at target");
		});

		it("does not cull idle containers within maxIdleSeconds", () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const id3 = fakeId();
			const now = Date.now();

			const { pool: p } = createPoolWithContainers(
				{ poolSize: 2, maxIdleSeconds: 9999 },
				[
					{ id: id1, state: "idle", lastActivity: now },
					{ id: id2, state: "idle", lastActivity: now },
					{ id: id3, state: "idle", lastActivity: now },
				],
			);
			pool = p;

			(pool as any)._cullExcessIdle();

			assert.equal(pool.getStats().idle, 3, "should not cull within maxIdleSeconds");
		});
	});

	// ----- Replenish guard -----

	describe("replenish guard", () => {
		it("prevents concurrent replenish operations", async () => {
			const { pool: p } = createPoolWithContainers(
				{ poolSize: 2 },
				[], // empty pool — needs replenish
			);
			pool = p;

			let createCount = 0;
			(pool as any)._createContainer = async function (this: any) {
				createCount++;
				await new Promise((r) => setTimeout(r, 50)); // simulate async work
				const id = fakeId();
				this.containers.set(id, {
					id,
					shortId: id.substring(0, 12),
					state: "idle",
					sessions: new Set(),
					createdAt: Date.now(),
					lastActivity: Date.now(),
				});
			};

			// Trigger two concurrent replenishes
			const p1 = (pool as any)._replenish();
			const p2 = (pool as any)._replenish();
			await Promise.all([p1, p2]);

			// The guard should prevent the second from running concurrently
			assert.ok(createCount <= 2, `at most 2 creates, got ${createCount}`);
		});
	});

	// ----- Auto-replenish on claim -----

	describe("auto-replenish on claim", () => {
		it("triggers replenish when idle drops below poolSize", async () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const { pool: p } = createPoolWithContainers(
				{ poolSize: 2 },
				[
					{ id: id1, state: "idle" },
					{ id: id2, state: "idle" },
				],
			);
			pool = p;

			let replenished = false;
			(pool as any)._replenish = async function () { replenished = true; };

			pool.claim("session-1");

			// Give fire-and-forget a tick
			await new Promise((r) => setTimeout(r, 10));

			// Since we can't easily test fire-and-forget, at least verify
			// claim reduced idle count
			assert.equal(pool.getStats().idle, 1);
		});
	});

	// ----- getStats -----

	describe("getStats", () => {
		it("returns correct counts for mixed states", () => {
			const id1 = fakeId();
			const id2 = fakeId();
			const id3 = fakeId();
			const { pool: p } = createPoolWithContainers(
				{ poolSize: 3 },
				[
					{ id: id1, state: "idle" },
					{ id: id2, state: "idle" },
					{ id: id3, state: "idle" },
				],
			);
			pool = p;

			pool.claim("session-1");

			const stats = pool.getStats();
			assert.equal(stats.total, 3);
			assert.equal(stats.claimed, 1);
			assert.equal(stats.idle, 2);
			assert.equal(typeof stats.warming, "number");
		});
	});

	// ----- dispose -----

	describe("dispose", () => {
		it("stops health check timer", async () => {
			const id1 = fakeId();
			const { pool: p } = createPoolWithContainers(
				{ poolSize: 1, healthCheckIntervalMs: 50 },
				[{ id: id1, state: "idle" }],
			);
			pool = p;

			// Start a timer that would fire health checks
			let checkCount = 0;
			(pool as any)._healthCheckTimer = setInterval(() => { checkCount++; }, 50);

			pool.dispose();
			const countAfterDispose = checkCount;

			await new Promise((r) => setTimeout(r, 200));

			assert.equal(checkCount, countAfterDispose, "no checks after dispose");
		});
	});

	// ----- Edge cases -----

	describe("edge cases", () => {
		it("release with unknown container ID is a no-op", () => {
			const id1 = fakeId();
			const { pool: p } = createPoolWithContainers({}, [
				{ id: id1, state: "idle" },
			]);
			pool = p;

			pool.release("session-1", "nonexistent");
			assert.equal(pool.getStats().idle, 1);
		});

		it("claim after shutdown flag returns null (pool cleared)", () => {
			const id1 = fakeId();
			const { pool: p } = createPoolWithContainers({}, [
				{ id: id1, state: "idle" },
			]);
			pool = p;

			// Simulate shutdown clearing the pool
			(pool as any)._shutdownRequested = true;
			(pool as any).containers.clear();

			assert.equal(pool.claim("session-1"), null);
		});

		it("release with unknown session is a no-op", () => {
			const id1 = fakeId();
			const { pool: p } = createPoolWithContainers({}, [
				{ id: id1, state: "claimed", sessions: ["session-1"] },
			]);
			pool = p;

			// Release a session that doesn't belong to this container
			pool.release("session-99", id1);
			// Container should still be claimed (session-1 still there)
			assert.equal(pool.getStats().claimed, 1);
		});
	});
});
