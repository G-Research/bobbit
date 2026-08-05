import { afterAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { parseServiceManifest, type ServiceRunMode, type ServiceRuntimeManifest } from "../../src/server/service-runtime/service-manifest.js";
import {
	ComposeServiceRunner,
	DockerServiceRunner,
	LocalServiceRunner,
	ServiceRunnerError,
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
		environment: {
			SERVICE_RUNTIME_PORT: "8888",
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

async function assertStopped(endpoint: string): Promise<void> {
	await expect(fetch(new URL("/health", `${endpoint}/`))).rejects.toThrow();
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

async function stopAndRemove(runner: ServiceRunner, started: Awaited<ReturnType<ServiceRunner["start"]>>, runnerInput: ServiceRunnerStartInput): Promise<void> {
	const control = { ...runnerInput, runnerIdentity: started.runnerIdentity };
	await runner.stop(control);
	await assertStopped(started.endpoint);
	await runner.remove(control);
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
			const runnerInput = input(manifest, mode, root, dataDir);
			const started = await runner.start(runnerInput);
			try {
				const port = endpointPort(started.endpoint);
				expect(port).not.toBe(8888);
				expect(await json(started.endpoint, "/health")).toEqual({ status: "ok" });
				const marker = `${mode}-${TEST_ID}`;
				await retainAndRecall(started.endpoint, marker);
				observations.push({ mode, endpoint: started.endpoint, port });
				await runner.stop({ ...runnerInput, runnerIdentity: started.runnerIdentity });
				await assertStopped(started.endpoint);

				// Restart against the same declared storage: stop preserves data.
				const restarted = await runner.start(runnerInput);
				try {
					expect(await json(restarted.endpoint, "/recall?key=session-marker")).toEqual({ value: marker });
				} finally {
					await stopAndRemove(runner, restarted, runnerInput);
				}
			} finally {
				await runner.remove({ ...runnerInput, runnerIdentity: started.runnerIdentity }).catch(() => {});
			}
		}

		expect(observations.map(({ mode }) => mode)).toEqual(["local", "docker", "compose"]);
		expect(observations.every(({ endpoint }) => endpoint.startsWith("http://127.0.0.1:"))).toBe(true);
	});

	it("bounds an unhealthy service and leaves independent session-style work usable", { timeout: 15_000 }, async () => {
		const root = makeRoot("runtime-unhealthy");
		const manifest = fixtureManifest(root);
		const unhealthyManifest: ServiceRuntimeManifest = {
			...manifest,
			endpoint: {
				...manifest.endpoint,
				health: { ...manifest.endpoint.health, startupTimeoutMs: 1_000 },
			},
		};
		const runner = new LocalServiceRunner();
		const runnerInput = input(unhealthyManifest, "local", root, join(root, "data"));
		runnerInput.environment.SERVICE_RUNTIME_UNHEALTHY = "1";
		const startedAt = Date.now();
		const [failure, independentOperation] = await Promise.all([
			runner.start(runnerInput).then(
			() => undefined,
			(error: unknown) => error,
			),
			new Promise((resolve) => setTimeout(() => resolve("session request completed"), 25)),
		]);
		expect(independentOperation).toBe("session request completed");
		expect(Date.now() - startedAt).toBeLessThan(7_000);
		expect(failure).toBeInstanceOf(ServiceRunnerError);
		expect((failure as ServiceRunnerError).code).toBe("SERVICE_UNHEALTHY");
	});
});
