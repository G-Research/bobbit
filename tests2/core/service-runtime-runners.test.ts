import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComposeServiceRunner,
	DockerServiceRunner,
	LocalServiceRunner,
	type ServiceRunnerStartInput,
} from "../../src/server/service-runtime/service-runners.js";

const manifest = {
	apiVersion: 1,
	id: "fixture",
	title: "Fixture",
	endpoint: {
		protocol: "http",
		servicePort: 8080,
		health: { path: "/health", expectedStatus: 200, requestTimeoutMs: 100, intervalMs: 100, startupTimeoutMs: 1_000 },
	},
	lifecycle: { startPolicy: "manual", restart: { policy: "never", maxAttempts: 0, windowMs: 1_000, initialBackoffMs: 100, maxBackoffMs: 100 } },
	environment: { HOST: { value: "127.0.0.1" } },
	modes: {
		local: { command: "fixture-server", args: ["--serve"], portEnv: "PORT", hostEnv: "HOST" },
		docker: { image: "fixture:latest", command: ["--serve"] },
		compose: { file: "runtime/compose.yaml", service: "fixture", projectName: "bobbit-fixture-${serverIdentity}" },
	},
} as any;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function startInput(mode: ServiceRunnerStartInput["mode"], packRoot = "/pack"): ServiceRunnerStartInput {
	return {
		manifest,
		mode,
		packRoot,
		descriptorDir: packRoot,
		serverIdentity: "server-1",
		serviceIdentity: "pack:fixture",
		packId: "pack",
		environment: { FIXTURE_SETTING: "value", HOST: "0.0.0.0" },
	};
}

function composeInput(): ServiceRunnerStartInput {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-runtime-runner-"));
	roots.push(root);
	fs.mkdirSync(path.join(root, "runtime"));
	fs.writeFileSync(path.join(root, "runtime", "compose.yaml"), [
		"services:", "  fixture:", "    image: fixture:latest", "    restart: 'no'",
		"    depends_on:", "      - sidecar",
		"    ports:", "      - '127.0.0.1::8080'",
		"  sidecar:", "    image: fixture-sidecar:latest", "    restart: 'no'",
	].join("\n"));
	const envFile = path.join(root, "runtime.env");
	fs.writeFileSync(envFile, "FIXTURE_SETTING=\"value\"\n", { mode: 0o600 });
	fs.chmodSync(envFile, 0o600);
	return { ...startInput("compose", root), envFile };
}

function child(pid = 1234) {
	const result = new Promise<any>(() => {}) as any;
	result.pid = pid;
	result.exitCode = null;
	result.kill = vi.fn(() => {
		result.exitCode = 0;
		return true;
	});
	return result;
}

function settledChild(outcome: unknown, exitCode: number | null = 1) {
	const result = (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)) as any;
	result.pid = 9000;
	result.exitCode = exitCode;
	result.kill = vi.fn(() => true);
	return result;
}

function commandResult(stdout = "", exitCode = 0) {
	return Promise.resolve({ stdout, stderr: "", exitCode }) as any;
}

describe("service runtime runners", () => {
	it("launches local services via argv, a dynamic loopback port, and a read-only inspect path", async () => {
		const process = child();
		const execute = vi.fn(() => process);
		const getPort = vi.fn(async () => 43123);
		const readiness = vi.fn(async () => {});
		const runner = new LocalServiceRunner({ execute, getPort, readiness });

		const started = await runner.start(startInput("local"));
		expect(started.endpoint).toBe("http://127.0.0.1:43123");
		expect(execute).toHaveBeenCalledWith("fixture-server", ["--serve"], expect.objectContaining({
			shell: false,
			reject: false,
			cwd: "/pack",
			env: expect.objectContaining({ FIXTURE_SETTING: "value", PORT: "43123", HOST: "127.0.0.1", PATH: expect.any(String) }),
		}));
		await expect(runner.inspect({ ...startInput("local"), runnerIdentity: started.runnerIdentity })).resolves.toEqual(started);
		expect(getPort).toHaveBeenCalledTimes(1);

		await runner.stop({ ...startInput("local"), runnerIdentity: started.runnerIdentity });
		expect(process.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("uses a fixed loader PATH without inheriting the gateway and allows an explicit override", async () => {
		const execute = vi.fn(() => child());
		const runner = new LocalServiceRunner({ execute, getPort: async () => 43123 });
		const gatewayPath = process.env.PATH;
		process.env.PATH = "/gateway-only";
		try {
			await runner.start(startInput("local"));
			const firstEnvironment = (execute.mock.calls[0] as any)?.[2]?.env;
			expect(firstEnvironment?.PATH).not.toBe("/gateway-only");
			expect(firstEnvironment?.PATH).toEqual(expect.any(String));
			await runner.start({ ...startInput("local"), environment: { FIXTURE_SETTING: "value", HOST: "0.0.0.0", PATH: "/runtime-loader" } });
			const secondEnvironment = (execute.mock.calls[1] as any)?.[2]?.env;
			expect(secondEnvironment).toMatchObject({ PATH: "/runtime-loader" });
		} finally {
			if (gatewayPath === undefined) delete process.env.PATH; else process.env.PATH = gatewayPath;
		}
	});

	it("discards immediate bind conflicts and caps allocation attempts", async () => {
		const execute = vi.fn(() => { throw new Error("EADDRINUSE"); });
		const getPort = vi.fn(async () => 44000 + getPort.mock.calls.length);
		const runner = new LocalServiceRunner({ execute, getPort });

		await expect(runner.start(startInput("local"))).rejects.toMatchObject({ code: "SERVICE_PORT_CONFLICT" });
		expect(getPort).toHaveBeenCalledTimes(3);
		expect(execute).toHaveBeenCalledTimes(3);
	});

	it("retries an early reject:false EADDRINUSE result instead of returning a false start", async () => {
		const execute = vi.fn(() => settledChild({ stdout: "", stderr: "listen EADDRINUSE", all: "listen EADDRINUSE", exitCode: 1 }));
		const getPort = vi.fn(async () => 44000 + getPort.mock.calls.length);
		const runner = new LocalServiceRunner({ execute, getPort });

		await expect(runner.start(startInput("local"))).rejects.toMatchObject({ code: "SERVICE_PORT_CONFLICT" });
		expect(getPort).toHaveBeenCalledTimes(3);
		expect(execute).toHaveBeenCalledTimes(3);
	});

	it.each([
		["ENOENT", new Error("spawn fixture-server ENOENT"), 1],
		["nonzero", { stdout: "", stderr: "failed", exitCode: 1 }, 1],
		["zero", { stdout: "", stderr: "", exitCode: 0 }, 0],
	])("fails a settled reject:false child with %s exit without waiting for readiness", async (_kind, outcome, exitCode) => {
		const execute = vi.fn(() => settledChild(outcome, exitCode));
		const getPort = vi.fn(async () => 44000);
		const runner = new LocalServiceRunner({ execute, getPort });

		await expect(runner.start(startInput("local"))).rejects.toMatchObject({ code: "SERVICE_LAUNCH_FAILED" });
		expect(getPort).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
	});

	it("uses Docker daemon port allocation and refuses to control a differently labelled container", async () => {
		const container = {
			id: "container-1",
			start: vi.fn(async () => {}),
			inspect: vi.fn(async () => ({
				Config: { Labels: { "io.bobbit.server": "server-1", "io.bobbit.service": "pack:fixture" } },
				State: { Running: true },
				NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "45123" }] } },
			})),
			stop: vi.fn(async () => {}),
			remove: vi.fn(async () => {}),
		};
		const docker = { createContainer: vi.fn(async () => container), getContainer: vi.fn(() => container) };
		const runner = new DockerServiceRunner({ docker, readiness: async () => {} });
		const started = await runner.start(startInput("docker"));

		expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
			Image: "fixture:latest",
			Cmd: ["--serve"],
			HostConfig: expect.objectContaining({ PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] } }),
		}));
		const [[dockerOptions]] = docker.createContainer.mock.calls as unknown as Array<[{ Env: string[] }]>;
		expect(dockerOptions!.Env).not.toContain("HOST=0.0.0.0");
		await runner.stop({ ...startInput("docker"), runnerIdentity: started.runnerIdentity });
		expect(container.stop).toHaveBeenCalledWith({ t: 10 });

		container.inspect.mockResolvedValueOnce({ Config: { Labels: {} }, State: { Running: true } } as any);
		await expect(runner.inspect({ ...startInput("docker"), runnerIdentity: started.runnerIdentity })).resolves.toBeUndefined();
		expect(docker.createContainer).toHaveBeenCalledTimes(1);
	});

	it("threads the same owner-only env file through every Compose lifecycle command", async () => {
		const execute = vi.fn()
			.mockReturnValueOnce(commandResult())
			.mockReturnValueOnce(commandResult("127.0.0.1:46234"))
			.mockReturnValueOnce(commandResult("container-id"))
			.mockReturnValueOnce(commandResult("127.0.0.1:46234"))
			.mockReturnValueOnce(commandResult())
			.mockReturnValueOnce(commandResult());
		const runner = new ComposeServiceRunner({ execute });
		const runnerInput = composeInput();
		const started = await runner.start(runnerInput);
		const file = path.join(runnerInput.packRoot, "runtime", "compose.yaml");
		const prefix = ["compose", "--env-file", runnerInput.envFile, "-p", "bobbit-fixture-server-1", "-f", file];
		expect(started.endpoint).toBe("http://127.0.0.1:46234");
		expect(execute.mock.calls[0]).toEqual(["docker", [...prefix, "up", "-d", "fixture"], expect.objectContaining({ shell: false, reject: false, extendEnv: false })]);
		expect(execute.mock.calls[1][1]).toEqual([...prefix, "port", "fixture", "8080"]);

		await runner.inspect({ ...runnerInput, runnerIdentity: started.runnerIdentity });
		await runner.stop({ ...runnerInput, runnerIdentity: started.runnerIdentity });
		await runner.remove({ ...runnerInput, runnerIdentity: started.runnerIdentity });
		expect(execute.mock.calls.slice(2).map((call) => call[1])).toEqual([
			[...prefix, "ps", "--status", "running", "-q", "fixture"],
			[...prefix, "port", "fixture", "8080"],
			[...prefix, "stop", "--timeout", "10"],
			[...prefix, "down", "--remove-orphans", "--timeout", "10"],
		]);
		const teardownCommands = execute.mock.calls.slice(4).map((call) => call[1].slice(prefix.length));
		expect(teardownCommands).toEqual([["stop", "--timeout", "10"], ["down", "--remove-orphans", "--timeout", "10"]]);
		expect(teardownCommands.flat()).not.toContain("-v");
		for (const call of execute.mock.calls) {
			expect(call[2]).toEqual(expect.objectContaining({ extendEnv: false }));
			expect((call[2] as { env?: Record<string, string> }).env?.FIXTURE_SETTING).toBeUndefined();
		}
	});

	it("rejects a Compose publication which is not loopback and tears down the owned project", async () => {
		const execute = vi.fn()
			.mockReturnValueOnce(commandResult())
			.mockReturnValueOnce(commandResult("0.0.0.0:8080"))
			.mockReturnValueOnce(commandResult());
		const runner = new ComposeServiceRunner({ execute });
		const runnerInput = composeInput();
		await expect(runner.start(runnerInput)).rejects.toMatchObject({ code: "SERVICE_LAUNCH_FAILED" });
		expect(execute.mock.calls[2]![1].slice(-4)).toEqual(["down", "--remove-orphans", "--timeout", "10"]);
		expect(execute.mock.calls[2]![1]).not.toContain("-v");
	});

	it("rejects shell interpreter command forms even when callers bypass manifest parsing", async () => {
		const execute = vi.fn(() => child());
		const runner = new LocalServiceRunner({ execute, getPort: async () => 43123 });
		const localManifest = structuredClone(manifest) as any;
		localManifest.modes.local = { command: "bash", args: ["-c", "echo nope"], portEnv: "PORT", hostEnv: "HOST" };
		await expect(runner.start({ ...startInput("local"), manifest: localManifest })).rejects.toMatchObject({ code: "SERVICE_LAUNCH_FAILED" });
		expect(execute).not.toHaveBeenCalled();

		const docker = { createContainer: vi.fn(), getContainer: vi.fn() };
		const dockerRunner = new DockerServiceRunner({ docker });
		const dockerManifest = structuredClone(manifest) as any;
		dockerManifest.modes.docker.command = ["pwsh", "-Command", "echo nope"];
		await expect(dockerRunner.start({ ...startInput("docker"), manifest: dockerManifest })).rejects.toMatchObject({ code: "SERVICE_LAUNCH_FAILED" });
		expect(docker.createContainer).not.toHaveBeenCalled();
	});
});
