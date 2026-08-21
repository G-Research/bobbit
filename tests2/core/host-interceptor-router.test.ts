import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { guardProcessEnv } from "./helpers/env-guard.js";
import { enableTsWorkerResolver } from "./helpers/enable-ts-worker.js";
guardProcessEnv();
enableTsWorkerResolver();
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError } from "../../src/server/extension-host/action-dispatcher.ts";
import { hostInterceptorAuditSink } from "../../src/server/extension-host/host-interceptor-audit.ts";
import { HostInterceptorRouter } from "../../src/server/extension-host/host-interceptor-router.ts";
import { ModuleHost, type InvokeRequest } from "../../src/server/extension-host/module-host-worker.ts";
import type { PackContributions } from "../../src/server/agent/pack-contributions.ts";
import type { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.ts";

function explicit(id: string, failurePolicy: "failOpen" | "failClosed" = "failOpen"): any {
	return {
		id,
		kind: "interceptor",
		interceptors: ["beforeToolCall"],
		failurePolicy,
		module: `../lib/${id}.mjs`,
		capabilities: [],
		budget: { maxTokens: 1000, timeoutMs: 500 },
		listName: id,
		sourceFile: `/packs/p/hooks/${id}.yaml`,
		packRoot: "/packs/p",
	};
}

function pack(hooks: any[] = [], providers: any[] = []): PackContributions {
	return {
		packId: "p", packName: "p", packRoot: "/packs/p",
		panels: [], entrypoints: [], channels: [], hooks, providers,
	};
}

function registryFor(p: PackContributions) {
	let active = true;
	let epoch = 3;
	const listeners = new Set<() => void>();
	const registry = {
		list: () => [p],
		listHooks: () => p.hooks,
		listProviders: () => p.providers,
		getActivationEpoch: () => epoch,
		onInvalidate: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		isHookAuthorized: () => active,
		isProviderAuthorized: () => active,
	} as unknown as PackContributionRegistry;
	return {
		registry,
		disable: () => { active = false; epoch++; for (const listener of listeners) listener(); },
		setInactive: () => { active = false; },
	};
}

const context = () => ({
	projectId: "project-1",
	sessionId: "session-1",
	cwd: process.cwd(),
	signal: new AbortController().signal,
});

describe("HostInterceptorRouter", () => {
	it("derives the protected transport snapshot only from live authorized fail-closed contributions", () => {
		const authority = registryFor(pack([
			explicit("ordinary", "failOpen"),
			explicit("protected", "failClosed"),
		]));
		const router = new HostInterceptorRouter({
			registry: authority.registry,
			moduleHost: {} as ModuleHost,
		});
		expect(router.requiresFailClosed("beforeToolCall", "project-1")).toBe(true);
		authority.setInactive();
		expect(router.requiresFailClosed("beforeToolCall", "project-1")).toBe(false);
	});

	it("validates and folds explicit mutations sequentially in normalized order", async () => {
		const declarations = [explicit("first"), explicit("second")];
		const { registry } = registryFor(pack(declarations));
		const calls: InvokeRequest[] = [];
		const moduleHost = {
			invoke: vi.fn(async (request: InvokeRequest) => {
				calls.push(request);
				return calls.length === 1 ? { action: "replaceArgs", args: { changed: true } } : { action: "allow" };
			}),
		} as unknown as ModuleHost;
		const router = new HostInterceptorRouter({
			registry,
			moduleHost,
			validateToolArgs: (_tool, args) => !!args && (args as any).changed === true,
		});
		const result = await router.dispatch("beforeToolCall", {
			toolCallId: "call-1", toolName: "demo", args: { original: true },
		}, context());
		expect(result.value.args).toEqual({ changed: true });
		expect(calls.map((call) => path.basename(new URL(call.url).pathname).split(".")[0])).toEqual(["first", "second"]);
		expect(calls[1].arg).toMatchObject({ args: { changed: true } });
		expect(result.decisions.map((row) => row.outcome)).toEqual(["applied", "applied"]);
		expect(result.decisions.every((row) => !Object.keys(row).some((key) => /args|result|error|path|prompt/i.test(key)))).toBe(true);
	});

	it("rechecks live authority immediately before application and discards a late result", async () => {
		const authority = registryFor(pack([explicit("late")]));
		const moduleHost = {
			invoke: vi.fn(async () => {
				authority.setInactive();
				return { action: "replaceArgs", args: { forbidden: true } };
			}),
		} as unknown as ModuleHost;
		const router = new HostInterceptorRouter({
			registry: authority.registry,
			moduleHost,
			validateToolArgs: () => true,
		});
		const result = await router.dispatch("beforeToolCall", {
			toolCallId: "call-1", toolName: "demo", args: { original: true },
		}, context());
		expect(result.value.args).toEqual({ original: true });
		expect(result.decisions[0]).toMatchObject({ outcome: "cancelled", cancelled: true, applied: false, proposalReceived: true });
	});

	it("rechecks capability authorization before applying a settled proposal", async () => {
		const declaration = explicit("authorized");
		declaration.capabilities = ["store"];
		const { registry } = registryFor(pack([declaration]));
		let authorized = true;
		const moduleHost = {
			invoke: vi.fn(async () => {
				authorized = false;
				return { action: "replaceArgs", args: { forbidden: true } };
			}),
		} as unknown as ModuleHost;
		const router = new HostInterceptorRouter({
			registry,
			moduleHost,
			validateToolArgs: () => true,
			isCapabilityAuthorized: () => authorized,
		});
		const result = await router.dispatch("beforeToolCall", {
			toolCallId: "call-1", toolName: "demo", args: { original: true },
		}, context());
		expect(result.value.args).toEqual({ original: true });
		expect(result.decisions[0].outcome).toBe("cancelled");
	});

	it("records the production diagnostic projection once and keeps sink failures non-fatal", async () => {
		const { registry } = registryFor(pack([explicit("audited")]));
		const moduleHost = {
			invoke: vi.fn(async () => ({ action: "allow" })),
		} as unknown as ModuleHost;
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const router = new HostInterceptorRouter({ registry, moduleHost, audit: hostInterceptorAuditSink });
		const result = await router.dispatch("beforeToolCall", {
			toolCallId: "call-sensitive", toolName: "demo", args: { secret: "forbidden args" },
		}, context());
		expect(result.decisions).toHaveLength(1);
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls[0]?.[0]).toBe("[host-interceptor-audit] %s");
		const diagnostic = JSON.parse(String(log.mock.calls[0]?.[1]));
		expect(diagnostic).toMatchObject({
			hook: "beforeToolCall", projectId: "project-1", sessionId: "session-1",
			packId: "p", contributionId: "audited", outcome: "applied",
			proposalReceived: true, valid: true, applied: true, timedOut: false, cancelled: false,
		});
		expect(JSON.stringify(diagnostic)).not.toMatch(/call-sensitive|forbidden|args|prompt|result|error|path/i);

		log.mockImplementation(() => { throw new Error("diagnostic sink unavailable"); });
		await expect(router.dispatch("beforeToolCall", {
			toolCallId: "call-2", toolName: "demo", args: {},
		}, context())).resolves.toMatchObject({ decisions: [{ outcome: "applied" }] });
		log.mockRestore();
	});

	it("applies a constant fail-closed decision without exposing worker errors", async () => {
		const { registry } = registryFor(pack([explicit("protected", "failClosed")]));
		const moduleHost = {
			invoke: vi.fn(async () => { throw new ActionError(504, "sensitive extension failure"); }),
		} as unknown as ModuleHost;
		const audit = vi.fn();
		const router = new HostInterceptorRouter({ registry, moduleHost, audit });
		const result = await router.dispatch("beforeToolCall", {
			toolCallId: "call-1", toolName: "demo", args: {},
		}, context());
		expect(result.terminal).toEqual({ action: "block", reasonCode: "not_permitted" });
		expect(result.decisions[0]).toMatchObject({ outcome: "failed-closed", timedOut: true, applied: false });
		expect(JSON.stringify(audit.mock.calls)).not.toContain("sensitive");
	});

	it("uses LifecycleHub's selective provider adapter and projects canonical context fields", async () => {
		const provider = {
			id: "memory", kind: "memory", module: "../lib/provider.mjs",
			hooks: ["beforePrompt"], budget: { maxTokens: 1000, timeoutMs: 500 },
			listName: "memory", sourceFile: "/packs/p/providers/memory.yaml", packRoot: "/packs/p",
		};
		const { registry } = registryFor(pack([], [provider]));
		const dispatchProvider = vi.fn(async () => ({
			blocks: [{
				id: "memory-1", title: "Memory", authority: "memory", content: "safe",
				reason: "relevant", priority: 1, providerId: "memory", tokenEstimate: 1,
			}],
			diagnostics: [],
		}));
		const router = new HostInterceptorRouter({
			registry,
			moduleHost: {} as ModuleHost,
			lifecycleHub: { dispatchProvider } as any,
		});
		const result = await router.dispatch("beforePrompt", {
			sessionId: "session-1", turnIndex: 1, source: "user", userText: "hello",
		}, context());
		expect(dispatchProvider).toHaveBeenCalledOnce();
		expect((result.value as any).context).toEqual([{
			id: "memory-1", title: "Memory", authority: "memory", content: "safe", reason: "relevant", priority: 1,
		}]);
	});
});

let tmp = "";
beforeAll(() => {
	// v2-core reuses forks with isolate:false. Re-assert the supported worker
	// bootstrap resolver immediately before this file spawns real ModuleHost
	// workers, after any sibling env guard may have restored NODE_OPTIONS.
	enableTsWorkerResolver();
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-hook-module-")));
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("ModuleHost hooks execution", () => {
	it("resolves canonical members from the default hooks export", async () => {
		const file = path.join(tmp, "hooks.mjs");
		fs.writeFileSync(file, "export default { beforePrompt: async (_ctx, request) => ({ context: [{ id: request.sessionId, title: 't', authority: 'memory', content: 'c', reason: 'r', priority: 1 }] }) };\n");
		const host = new ModuleHost({ timeoutMs: 30_000 });
		try {
			const value = await host.invoke({
				url: pathToFileURL(file).href, packRoot: tmp, epoch: 0, exportKind: "hooks", member: "beforePrompt",
				ctx: { sessionId: "session-1", tool: "hook", host: {} } as any,
				arg: { sessionId: "session-1" }, workingDir: tmp,
			});
			expect(value).toMatchObject({ context: [{ id: "session-1" }] });
		} finally { host.dispose(); }
	});

	it("terminates a worker when the host cancellation signal aborts", async () => {
		const file = path.join(tmp, "hanging.mjs");
		fs.writeFileSync(file, "export default { beforePrompt: async () => new Promise(() => {}) };\n");
		const host = new ModuleHost({ timeoutMs: 10_000 });
		const controller = new AbortController();
		try {
			const invocation = host.invoke({
				url: pathToFileURL(file).href, packRoot: tmp, epoch: 0, exportKind: "hooks", member: "beforePrompt",
				ctx: { sessionId: "session-1", tool: "hook", host: {} } as any,
				arg: {}, workingDir: tmp, signal: controller.signal,
			});
			setTimeout(() => controller.abort(), 25);
			await expect(invocation).rejects.toMatchObject({ status: 499 });
		} finally { host.dispose(); }
	});
});
