import { describe, expect, it, vi } from "vitest";
import {
	ComposeServiceRunner,
	DockerServiceRunner,
	LocalServiceRunner,
	ServiceRunnerError,
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
	environment: {},
	modes: {
		local: { command: "fixture-server", args: ["--serve"], portEnv: "PORT" },
		docker: { image: "fixture:latest", command: ["--serve"] },
		compose: { file: "runtime/compose.yaml", service: "fixture", projectName: "bobbit-fixture" },
	},
} as any;

function startInput(mode: ServiceRunnerStartInput["mode"]): ServiceRunnerStartInput {
	return {
		manifest,
		mode,
		packRoot: "/pack",
		serverIdentity: "server-1",
		serviceIdentity: "pack:fixture",
		packId: "pack",
		environment: { FIXTURE_SETTING: "value" },
	};
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
			env: { FIXTURE_SETTING: "value", PORT: "43123" },
		}));
		await expect(runner.inspect({ ...startInput("local"), runnerIdentity: started.runnerIdentity })).resolves.toEqual(started);
		expect(getPort).toHaveBeenCalledTimes(1);

		await runner.stop({ ...startInput("local"), runnerIdentity: started.runnerIdentity });
		expect(process.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("discards a conflicted local candidate and caps allocation attempts", async () => {
		const execute = vi.fn(() => child());
		const getPort = vi.fn(async () => 44000 + getPort.mock.calls.length);
		const readiness = vi.fn(async () => {
			if (readiness.mock.calls.length <= 3) throw new ServiceRunnerError("SERVICE_UNHEALTHY", "EADDRINUSE");
		});
		const runner = new LocalServiceRunner({ execute, getPort, readiness });

		await expect(runner.start(startInput("local"))).rejects.toMatchObject({ code: "SERVICE_PORT_CONFLICT" });
		expect(getPort).toHaveBeenCalledTimes(3);
		expect(execute).toHaveBeenCalledTimes(3);
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
		await runner.stop({ ...startInput("docker"), runnerIdentity: started.runnerIdentity });
		expect(container.stop).toHaveBeenCalledWith({ t: 10 });

		container.inspect.mockResolvedValueOnce({ Config: { Labels: {} }, State: { Running: true } } as any);
		await expect(runner.inspect({ ...startInput("docker"), runnerIdentity: started.runnerIdentity })).resolves.toBeUndefined();
		expect(docker.createContainer).toHaveBeenCalledTimes(1);
	});

	it("scopes Compose argv to its project, contained file, and declared service", async () => {
		const execute = vi.fn()
			.mockReturnValueOnce(commandResult())
			.mockReturnValueOnce(commandResult("127.0.0.1:46234"))
			.mockReturnValueOnce(commandResult());
		const runner = new ComposeServiceRunner({ execute, readiness: async () => {} });
		const started = await runner.start(startInput("compose"));
		expect(started.endpoint).toBe("http://127.0.0.1:46234");
		expect(execute.mock.calls[0]).toEqual(["docker", ["compose", "-p", "bobbit-fixture", "-f", "/pack/runtime/compose.yaml", "up", "-d", "fixture"], expect.objectContaining({ shell: false, reject: false })]);
		expect(execute.mock.calls[1][1]).toEqual(["compose", "-p", "bobbit-fixture", "-f", "/pack/runtime/compose.yaml", "port", "fixture", "8080"]);

		await runner.stop({ ...startInput("compose"), runnerIdentity: started.runnerIdentity });
		expect(execute.mock.calls[2][1]).toEqual(["compose", "-p", "bobbit-fixture", "-f", "/pack/runtime/compose.yaml", "stop", "--timeout", "10", "fixture"]);
	});

	it("rejects a Compose publication which is not loopback", async () => {
		const execute = vi.fn()
			.mockReturnValueOnce(commandResult())
			.mockReturnValueOnce(commandResult("0.0.0.0:8080"));
		const runner = new ComposeServiceRunner({ execute, readiness: async () => {} });
		await expect(runner.start(startInput("compose"))).rejects.toMatchObject({ code: "SERVICE_LAUNCH_FAILED" });
	});
});
