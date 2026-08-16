import { afterAll, describe, expect, it, vi } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import type { RuntimeContribution } from "../../src/server/agent/pack-contributions.js";
import { parseServiceManifest, type ServiceRunMode, type ServiceRuntimeManifest } from "../../src/server/service-runtime/service-manifest.js";
import { ServiceRuntimeStore } from "../../src/server/service-runtime/service-runtime-store.js";
import { ServiceRuntimeSupervisor } from "../../src/server/service-runtime/service-supervisor.js";
import {
	ComposeServiceRunner,
	DockerServiceRunner,
	LocalServiceRunner,
	type ServiceRunner,
	type ServiceRunnerStartInput,
} from "../../src/server/service-runtime/service-runners.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = resolve(HERE, "../fixtures/service-runtime");
const DOCKER_IMAGE = "bobbit-service-runtime-e2e:latest";
const TEST_ID = `runtime-e2e-${process.pid}-${Date.now().toString(36)}`;
const roots: string[] = [];

function makeRoot(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `bobbit-${label}-`));
	roots.push(root);
	cpSync(FIXTURE_SOURCE, root, { recursive: true });
	return root;
}

function endpointPort(endpoint: string): number {
	const url = new URL(endpoint);
	expect(url.hostname).toBe("127.0.0.1");
	expect(Number(url.port)).toBeGreaterThan(0);
	return Number(url.port);
}

function fixtureManifest(root: string): ServiceRuntimeManifest {
	const raw = parseYaml(readFileSync(join(root, "runtime.yaml"), "utf8"));
	const parsed = parseServiceManifest(raw, { packRoot: root, sourceFile: join(root, "runtime.yaml") });
	if (!parsed) throw new Error("service-runtime E2E fixture manifest must be valid");
	// The descriptor keeps its authored template. The host owns its one resolved
	// server identity before the runner receives it.
	return {
		...parsed,
		modes: {
			...parsed.modes,
			compose: {
				...parsed.modes.compose,
				projectName: `bobbit-runtime-${TEST_ID}`,
			},
		},
	};
}

function input(
	manifest: ServiceRuntimeManifest,
	mode: ServiceRunMode,
	root: string,
	dataDir: string,
): ServiceRunnerStartInput {
	return {
		manifest,
		mode,
		packRoot: root,
		serverIdentity: TEST_ID,
		serviceIdentity: "service-runtime-e2e/fixture-service",
		packId: "service-runtime-e2e",
		environment: {
			SERVICE_RUNTIME_PORT: "8888",
			// The local runner must discard this authored wildcard and force the
			// descriptor-declared host variable to loopback for the child process.
			SERVICE_RUNTIME_HOST: "0.0.0.0",
			// The local process receives the host path; containers receive their
			// declared target and the runner owns the host bind separately.
			SERVICE_RUNTIME_DATA_DIR: mode === "docker" ? "/data" : dataDir,
		},
		storage: { hostPath: dataDir, target: "/data" },
	};
}

async function json(endpoint: string, path: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(new URL(path, `${endpoint}/`), init);
	expect(response.ok, `${init?.method ?? "GET"} ${path} failed with ${response.status}`).toBe(true);
	return response.json();
}

async function retainAndRecall(endpoint: string, marker: string): Promise<void> {
	await json(endpoint, "/retain", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: "session-marker", value: marker }),
	});
	expect(await json(endpoint, "/recall?key=session-marker")).toEqual({ value: marker });
}

/** Adapters only launch and discover; this keeps the direct matrix readiness-bounded. */
async function waitForHealth(endpoint: string, manifest: ServiceRuntimeManifest): Promise<void> {
	const health = manifest.endpoint.health;
	const deadline = Date.now() + health.startupTimeoutMs;
	let lastFailure = "endpoint did not respond";
	do {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), health.requestTimeoutMs);
		try {
			const response = await fetch(new URL(health.path, `${endpoint}/`), { signal: controller.signal });
			if (response.status === health.expectedStatus) return;
			lastFailure = `expected ${health.expectedStatus}, received ${response.status}`;
		} catch (error) {
			lastFailure = error instanceof Error ? error.name : String(error);
		} finally {
			clearTimeout(timeout);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(health.intervalMs, remaining)));
	} while (Date.now() <= deadline);
	throw new Error(`fixture readiness exceeded ${health.startupTimeoutMs}ms: ${lastFailure}`);
}

async function assertStopped(endpoint: string, timeoutMs = 5_000, label = "fixture"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	do {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 250);
		try {
			await fetch(new URL("/health", `${endpoint}/`), { signal: controller.signal });
		} catch {
			return;
		} finally {
			clearTimeout(timeout);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() <= deadline);
	throw new Error(`${label} did not stop within ${timeoutMs}ms at ${endpoint}`);
}

async function dockerAvailable(): Promise<boolean> {
	try {
		await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

async function buildFixtureImage(root: string): Promise<void> {
	// `--pull=false` makes missing local bases an explicit E2E failure rather
	// than reaching out to a registry. The purpose-built image has no runtime
	// dependency beyond the fixture copied into this isolated root.
	await execFileAsync("docker", ["build", "--pull=false", "--tag", DOCKER_IMAGE, root], { timeout: 120_000 });
}

async function composeProjectContainerIds(project: string): Promise<string[]> {
	const { stdout } = await execFileAsync("docker", ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], { timeout: 10_000 });
	return stdout.split(/\r?\n/).filter(Boolean);
}

async function stopAndRemove(
	runner: ServiceRunner,
	started: Awaited<ReturnType<ServiceRunner["start"]>>,
	runnerInput: ServiceRunnerStartInput,
	afterRemove?: () => Promise<void>,
): Promise<void> {
	const control = { ...runnerInput, runnerIdentity: started.runnerIdentity };
	await runner.stop(control);
	await assertStopped(started.endpoint);
	await runner.remove(control);
	await afterRemove?.();
}

afterAll(async () => {
	try {
		if (await dockerAvailable()) {
			await execFileAsync("docker", ["image", "rm", "--force", DOCKER_IMAGE], { timeout: 30_000 }).catch(() => {});
		}
	} finally {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	}
});

describe.sequential("service-runtime real adapter matrix", () => {
	it("reports an unavailable Docker runtime instead of silently skipping the contract", async () => {
		if (await dockerAvailable()) return;
		const root = makeRoot("runtime-unavailable");
		const dataDir = join(root, "data");
		const runner = new DockerServiceRunner();
		await expect(runner.start(input(fixtureManifest(root), "docker", root, dataDir))).rejects.toMatchObject({
			code: "SERVICE_DOCKER_UNAVAILABLE",
		});
	});

	it("forces a real local child that requests wildcard binding onto loopback", { timeout: 15_000 }, async () => {
		const root = makeRoot("runtime-local-loopback");
		const manifest = fixtureManifest(root);
		const dataDir = join(root, "data");
		const runner = new LocalServiceRunner();
		const runnerInput = { ...input(manifest, "local", root, dataDir), descriptorDir: root };
		const started = await runner.start(runnerInput);
		try {
			await waitForHealth(started.endpoint, manifest);
			expect(await json(started.endpoint, "/health")).toEqual({ status: "ok", listener: "127.0.0.1" });
		} finally {
			await runner.remove({ ...runnerInput, runnerIdentity: started.runnerIdentity });
		}
	});

	it("runs the unchanged fixture via local, Docker, and Compose with one endpoint contract", { timeout: 180_000 }, async () => {
		if (!(await dockerAvailable())) return;

		const imageRoot = makeRoot("runtime-image");
		await buildFixtureImage(imageRoot);
		const observations: Array<{ mode: string; endpoint: string; port: number }> = [];
		for (const [mode, runner] of [
			["local", new LocalServiceRunner()],
			["docker", new DockerServiceRunner()],
			["compose", new ComposeServiceRunner()],
		] as const) {
			const root = makeRoot(`runtime-${mode}`);
			const manifest = fixtureManifest(root);
			const dataDir = join(root, "data");
			const runnerInput = { ...input(manifest, mode, root, dataDir), descriptorDir: root };
			const started = await runner.start(runnerInput);
			try {
				const port = endpointPort(started.endpoint);
				expect(port).not.toBe(8888);
				await waitForHealth(started.endpoint, manifest).catch((error: unknown) => {
					throw new Error(`${mode} fixture failed readiness`, { cause: error });
				});
				expect(await json(started.endpoint, "/health")).toMatchObject({ status: "ok" });
				const marker = `${mode}-${TEST_ID}`;
				await retainAndRecall(started.endpoint, marker);
				if (mode === "compose") {
					// `up service` starts the declared sidecar too; lifecycle cleanup
					// must own this entire descriptor-scoped project.
					expect(await composeProjectContainerIds(manifest.modes.compose.projectName)).toHaveLength(2);
				}
				observations.push({ mode, endpoint: started.endpoint, port });
				await runner.stop({ ...runnerInput, runnerIdentity: started.runnerIdentity });
				await assertStopped(started.endpoint, 5_000, mode);
				if (mode === "compose") {
					expect(readFileSync(join(dataDir, "records.json"), "utf8")).toContain(marker);
				}

				// Restart against the same declared storage: stop preserves data.
				const restarted = await runner.start(runnerInput);
				try {
					await waitForHealth(restarted.endpoint, manifest).catch((error: unknown) => {
						throw new Error(`${mode} fixture failed restart readiness`, { cause: error });
					});
					expect(await json(restarted.endpoint, "/recall?key=session-marker")).toEqual({ value: marker });
				} finally {
					await stopAndRemove(runner, restarted, runnerInput, async () => {
						if (mode === "compose") {
							expect(await composeProjectContainerIds(manifest.modes.compose.projectName)).toEqual([]);
							// Project teardown deliberately does not pass `-v`: the declared
							// host bind remains intact after every Compose resource is gone.
							expect(readFileSync(join(dataDir, "records.json"), "utf8")).toContain(marker);
						}
					});
				}
			} finally {
				await runner.remove({ ...runnerInput, runnerIdentity: started.runnerIdentity }).catch(() => {});
			}
		}

		expect(observations.map(({ mode }) => mode)).toEqual(["local", "docker", "compose"]);
		expect(observations.every(({ endpoint }) => endpoint.startsWith("http://127.0.0.1:"))).toBe(true);
	});

	it("bounds an unhealthy service through the real supervisor and leaves independent session-style work usable", { timeout: 15_000 }, async () => {
		const root = makeRoot("runtime-unhealthy");
		const dataDir = join(root, "data");
		const manifest = fixtureManifest(root);
		const unhealthyManifest: ServiceRuntimeManifest = {
			...manifest,
			endpoint: {
				...manifest.endpoint,
				health: { ...manifest.endpoint.health, intervalMs: 50, requestTimeoutMs: 100, startupTimeoutMs: 1_000 },
			},
			environment: {
				...manifest.environment,
				SERVICE_RUNTIME_UNHEALTHY: { value: "1" },
			},
		};
		const contribution: RuntimeContribution = {
			id: unhealthyManifest.id,
			listName: "runtime.yaml",
			sourceFile: join(root, "runtime.yaml"),
			packRoot: root,
			manifest: unhealthyManifest,
		};
		const store = new ServiceRuntimeStore({ stateDir: join(root, "runtime-state"), serverIdentity: TEST_ID });
		const identity = store.identity("service-runtime-e2e", unhealthyManifest.id);
		const runner = new LocalServiceRunner();
		const remove = vi.spyOn(runner, "remove");
		const supervisor = new ServiceRuntimeSupervisor({
			registry: { getRuntime: () => contribution } as any,
			store,
			runners: [runner],
			authorizer: { authorize: async () => true },
			settings: {
				resolve: async () => ({
					mode: "local" as const,
					revision: "unhealthy-e2e",
					values: { fixtureDataDir: dataDir },
					storage: { dataPath: dataDir, ownedRoot: root },
				}),
			},
			serverIdentity: TEST_ID,
		});
		const startedAt = Date.now();
		const [status, independentOperation] = await Promise.all([
			supervisor.start(identity),
			new Promise((resolve) => setTimeout(() => resolve("session request completed"), 25)),
		]);
		expect(independentOperation).toBe("session request completed");
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		expect(status).toMatchObject({ desired: "running", state: "degraded", diagnostic: { code: "SERVICE_DEGRADED" } });
		expect(status).not.toHaveProperty("endpoint");
		await expect(supervisor.context(identity)).resolves.toEqual({ state: "degraded", diagnostic: { code: "SERVICE_DEGRADED" } });
		const persisted = await store.load(identity);
		expect(persisted).toMatchObject({ desired: "running", lastDiagnostic: { code: "SERVICE_DEGRADED" } });
		expect(persisted?.endpoint).toBeUndefined();
		expect(persisted?.runnerIdentity).toBeUndefined();
		expect(remove).toHaveBeenCalledTimes(1);
	});
});
