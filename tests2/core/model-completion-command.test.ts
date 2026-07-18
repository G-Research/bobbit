import { afterEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { ApiModel } from "../../src/server/agent/model-registry.js";

const virtualModelConfig = vi.hoisted(() => ({ modelsJson: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const isModelsJson = (value: unknown) => String(value).replaceAll("\\", "/").endsWith("/virtual-agent/models.json");
	return {
		...actual,
		existsSync: (file: unknown) => isModelsJson(file) && virtualModelConfig.modelsJson !== undefined,
		readFileSync: (file: unknown) => {
			if (!isModelsJson(file) || virtualModelConfig.modelsJson === undefined) throw new Error(`unexpected fake read: ${String(file)}`);
			return virtualModelConfig.modelsJson;
		},
	};
});

vi.mock("../../src/server/bobbit-dir.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/server/bobbit-dir.js")>();
	return {
		...actual,
		globalAgentDir: () => "/virtual-agent",
		globalAuthPath: () => "/virtual-agent/auth.json",
	};
});

import {
	completeModelText,
	resolveConfigValue,
	type ModelConfigCommandRunner,
} from "../../src/server/agent/model-completion.js";

type RunnerResult = { stdout: unknown; stderr: unknown };
type RunnerCall = { file: string; args: string[]; options: Record<string, unknown> };

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

class FakeRunner {
	readonly calls: RunnerCall[] = [];
	active = 0;
	maxActive = 0;
	private readonly callWaiters: Array<{ count: number; done: () => void }> = [];

	constructor(private readonly handler: (call: RunnerCall) => Promise<RunnerResult> | RunnerResult) {}

	readonly execFile = async (file: string, args: string[], options: Record<string, unknown>): Promise<any> => {
		const call = { file, args: [...args], options: { ...options } };
		this.calls.push(call);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		for (let index = this.callWaiters.length - 1; index >= 0; index--) {
			if (this.calls.length >= this.callWaiters[index].count) this.callWaiters.splice(index, 1)[0].done();
		}
		try {
			return await this.handler(call);
		} finally {
			this.active--;
		}
	};

	waitForCallCount(count: number): Promise<void> {
		if (this.calls.length >= count) return Promise.resolve();
		return new Promise((done) => this.callWaiters.push({ count, done }));
	}

	asCommandRunner(): ModelConfigCommandRunner {
		return this as unknown as ModelConfigCommandRunner;
	}
}

function expectedShell(command: string): { file: string; args: string[] } {
	return process.platform === "win32"
		? { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] }
		: { file: "/bin/sh", args: ["-c", command] };
}

const model: ApiModel = {
	id: "test-model",
	name: "Test Model",
	provider: "aigw",
	api: "openai-completions",
	baseUrl: "https://gateway.invalid/v1",
	contextWindow: 8_192,
	maxTokens: 4_096,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	authenticated: true,
};

const emptyEnv = {} as NodeJS.ProcessEnv;

afterEach(() => {
	virtualModelConfig.modelsJson = undefined;
});

describe("async model configuration commands", () => {
	it("preserves literal, none, environment-name, blank, and non-string resolution without invoking the runner", async () => {
		const runner = new FakeRunner(() => {
			throw new Error("runner must not be called");
		});
		const env = { CONFIGURED_TOKEN: "from-injected-env", EMPTY_TOKEN: "" } as NodeJS.ProcessEnv;

		assert.equal(await resolveConfigValue("  literal value  ", runner.asCommandRunner(), env), "literal value");
		assert.equal(await resolveConfigValue(" none ", runner.asCommandRunner(), env), "none");
		assert.equal(await resolveConfigValue(" CONFIGURED_TOKEN ", runner.asCommandRunner(), env), "from-injected-env");
		assert.equal(await resolveConfigValue("EMPTY_TOKEN", runner.asCommandRunner(), env), "EMPTY_TOKEN");
		assert.equal(await resolveConfigValue("   ", runner.asCommandRunner(), env), undefined);
		assert.equal(await resolveConfigValue(undefined, runner.asCommandRunner(), env), undefined);
		assert.equal(await resolveConfigValue(42, runner.asCommandRunner(), env), undefined);
		assert.deepEqual(runner.calls, []);
	});

	it("uses the platform-default shell with the exact command and 15-second process options", async () => {
		const runner = new FakeRunner(() => ({ stdout: "  resolved value\r\n", stderr: "ignored warning" }));
		const command = "printf model-secret";

		assert.equal(await resolveConfigValue(`!${command}`, runner.asCommandRunner(), emptyEnv), "resolved value");
		assert.equal(runner.calls.length, 1);
		const expected = expectedShell(command);
		assert.equal(runner.calls[0].file, expected.file);
		assert.deepEqual(runner.calls[0].args, expected.args);
		assert.deepEqual(runner.calls[0].options, {
			encoding: "utf-8",
			timeout: 15_000,
			windowsHide: true,
		});
		for (const omitted of ["cwd", "env", "stdio", "shell", "input", "maxBuffer"]) {
			assert.equal(Object.hasOwn(runner.calls[0].options, omitted), false, `${omitted} must remain inherited/defaulted`);
		}
	});

	it("decodes Buffer stdout, trims it, ignores stderr, and drops empty or malformed stdout", async () => {
		const outputs: RunnerResult[] = [
			{ stdout: Buffer.from("  utf8-✓  \n", "utf-8"), stderr: Buffer.from("ignored") },
			{ stdout: " \r\n\t", stderr: "ignored" },
			{ stdout: undefined, stderr: "ignored" },
			{ stdout: 17, stderr: "ignored" },
		];
		const runner = new FakeRunner(() => outputs.shift()!);

		assert.equal(await resolveConfigValue("!buffer", runner.asCommandRunner(), emptyEnv), "utf8-✓");
		assert.equal(await resolveConfigValue("!empty", runner.asCommandRunner(), emptyEnv), undefined);
		assert.equal(await resolveConfigValue("!missing", runner.asCommandRunner(), emptyEnv), undefined);
		assert.equal(await resolveConfigValue("!number", runner.asCommandRunner(), emptyEnv), undefined);
		assert.equal(runner.calls.length, 4);
	});

	it.each([
		["non-zero exit", Object.assign(new Error("exit 7"), { code: 7 })],
		["spawn rejection", Object.assign(new Error("ENOENT"), { code: "ENOENT" })],
		["signal", Object.assign(new Error("terminated"), { signal: "SIGTERM" })],
		["timeout", Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true })],
	])("maps %s command failures to undefined", async (_name, failure) => {
		const runner = new FakeRunner(async () => { throw failure; });
		await expect(resolveConfigValue("!failing-command", runner.asCommandRunner(), emptyEnv)).resolves.toBeUndefined();
		assert.equal(runner.calls.length, 1);
	});

	it("leaves the event loop free while the injected command promise is pending", async () => {
		const command = deferred<RunnerResult>();
		const runner = new FakeRunner(() => command.promise);
		let settled = false;
		const resolution = resolveConfigValue("!deferred-command", runner.asCommandRunner(), emptyEnv)
			.then((value) => { settled = true; return value; });
		await runner.waitForCallCount(1);

		let independentMicrotaskRan = false;
		queueMicrotask(() => { independentMicrotaskRan = true; });
		await Promise.resolve();
		assert.equal(independentMicrotaskRan, true);
		assert.equal(settled, false);

		command.resolve({ stdout: "done", stderr: "" });
		assert.equal(await resolution, "done");
	});
});

describe("completeModelText command integration", () => {
	it("awaits API-key and AIGW header commands sequentially, preserving header order and completion options", async () => {
		virtualModelConfig.modelsJson = JSON.stringify({
			providers: {
				aigw: {
					apiKey: "!resolve-api-key",
					headers: {
						"X-First": "!resolve-first-header",
						"X-Literal": "literal-header",
						"X-Second": "!resolve-second-header",
					},
				},
			},
		});
		const pending = new Map<string, Deferred<RunnerResult>>([
			["resolve-api-key", deferred<RunnerResult>()],
			["resolve-first-header", deferred<RunnerResult>()],
			["resolve-second-header", deferred<RunnerResult>()],
		]);
		const runner = new FakeRunner((call) => pending.get(call.args.at(-1)!)!.promise);
		let completionCalled = false;
		const completionCalls: any[] = [];
		const completeFn = async (piModel: any, context: any, options: any) => {
			completionCalled = true;
			completionCalls.push({ piModel, context, options });
			return {
				role: "assistant",
				content: [{ type: "text", text: "  complete " }, { type: "toolCall" }, { type: "text", text: "response  " }],
				stopReason: "stop",
			} as any;
		};
		const completion = completeModelText(
			model,
			{ get: () => undefined } as any,
			{
				systemPrompt: "system text",
				userPrompt: "user text",
				maxTokens: 321,
				thinkingLevel: "high",
				timeoutMs: 4_321,
			},
			completeFn,
			{ commandRunner: runner.asCommandRunner(), env: emptyEnv },
		);

		await runner.waitForCallCount(1);
		assert.deepEqual(runner.calls.map((call) => call.args.at(-1)), ["resolve-api-key"]);
		assert.equal(completionCalled, false);
		pending.get("resolve-api-key")!.resolve({ stdout: " api-secret\n", stderr: "ignored" });

		await runner.waitForCallCount(2);
		assert.deepEqual(runner.calls.map((call) => call.args.at(-1)), ["resolve-api-key", "resolve-first-header"]);
		assert.equal(runner.active, 1);
		assert.equal(completionCalled, false);
		pending.get("resolve-first-header")!.resolve({ stdout: " first-value ", stderr: "ignored" });

		await runner.waitForCallCount(3);
		assert.deepEqual(runner.calls.map((call) => call.args.at(-1)), [
			"resolve-api-key",
			"resolve-first-header",
			"resolve-second-header",
		]);
		assert.equal(runner.active, 1);
		assert.equal(completionCalled, false);
		pending.get("resolve-second-header")!.resolve({ stdout: "second-value\n", stderr: "ignored" });

		assert.equal(await completion, "complete response");
		assert.equal(runner.maxActive, 1, "config commands must resolve sequentially");
		assert.equal(completionCalls.length, 1);
		assert.deepEqual(completionCalls[0].options, {
			maxTokens: 321,
			timeoutMs: 4_321,
			maxRetries: 0,
			cacheRetention: "none",
			apiKey: "api-secret",
			headers: {
				"X-First": "first-value",
				"X-Literal": "literal-header",
				"X-Second": "second-value",
			},
			reasoning: "high",
		});
		assert.deepEqual(Object.keys(completionCalls[0].options.headers), ["X-First", "X-Literal", "X-Second"]);
		assert.equal(completionCalls[0].piModel.id, model.id);
		assert.equal(completionCalls[0].context.systemPrompt, "system text");
		assert.equal(completionCalls[0].context.messages.length, 1);
		assert.equal(completionCalls[0].context.messages[0].role, "user");
		assert.equal(completionCalls[0].context.messages[0].content, "user text");
		assert.equal(typeof completionCalls[0].context.messages[0].timestamp, "number");
	});

	it("preserves completion error messages after configuration resolves", async () => {
		const runner = new FakeRunner(() => {
			throw new Error("runner must not be called");
		});
		const prefs = { get: (key: string) => key === "providerKey.direct" ? "direct-key" : undefined } as any;
		const directModel = { ...model, provider: "direct" };
		const failingCompleter = async () => ({ stopReason: "error", errorMessage: "provider rejected request", content: [] }) as any;

		await expect(completeModelText(
			directModel,
			prefs,
			{ systemPrompt: "system", userPrompt: "user" },
			failingCompleter,
			{ commandRunner: runner.asCommandRunner(), env: emptyEnv },
		)).rejects.toThrow("provider rejected request");
		assert.deepEqual(runner.calls, []);
	});
});
