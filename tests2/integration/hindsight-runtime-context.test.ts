import { beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { enableTsWorkerResolver } from "../core/helpers/enable-ts-worker.js";
import { LifecycleHub, type HookCtx, type RuntimeContextResolutionInput } from "../../src/server/agent/lifecycle-hub.ts";
import type { ProviderContribution } from "../../src/server/agent/pack-contributions.ts";
import type { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.ts";
import { ModuleHost } from "../../src/server/extension-host/module-host-worker.ts";
import { ContextTraceStore } from "../../src/server/agent/context-trace-store.ts";
import type { ServiceRuntimeContext } from "../../src/server/service-runtime/index.ts";

beforeAll(() => { enableTsWorkerResolver(); });

function tmpDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-runtime-context-")));
}

function provider(root: string, id: string, runtime?: string): ProviderContribution {
	const module = `${id}.mjs`;
	fs.writeFileSync(path.join(root, module), `
		export default {
			async sessionSetup(ctx) {
				return { blocks: [{
					id: ${JSON.stringify(id)}, title: "runtime", authority: "memory", priority: 1, reason: "test",
					content: JSON.stringify(ctx.runtime ?? null),
				}] };
			}
		};
	`, "utf8");
	return {
		id,
		kind: "memory",
		module,
		hooks: ["sessionSetup"],
		...(runtime ? { runtime } : {}),
		budget: { maxTokens: 400, timeoutMs: 10_000 },
		listName: id,
		sourceFile: path.join(root, "pack.yaml"),
		packRoot: root,
	};
}

function registry(providers: ProviderContribution[]): PackContributionRegistry {
	return { listProviders: () => providers } as unknown as PackContributionRegistry;
}

function base(root: string): Omit<HookCtx, "budget" | "config" | "gateway" | "scopeContext" | "runtime"> {
	return { sessionId: "session-1", projectId: "project-1", scope: "project", cwd: root };
}

function runtimeFrom(result: Awaited<ReturnType<LifecycleHub["dispatch"]>>, id: string): ServiceRuntimeContext | null {
	const block = result.blocks.find((candidate) => candidate.providerId === id);
	assert.ok(block, `provider ${id} should run`);
	return JSON.parse(block.content) as ServiceRuntimeContext | null;
}

describe("Hindsight runtime context across the LifecycleHub worker seam", () => {
	it("injects one mode-free endpoint contract only for declared runtime providers", async () => {
		const root = tmpDir();
		const worker = new ModuleHost({ timeoutMs: 10_000 });
		const endpoint = "http://127.0.0.1:49152";
		const calls: RuntimeContextResolutionInput[] = [];
		let controlCalls = 0;
		let allocationCalls = 0;
		const runtimeService = {
			readContext: async (input: RuntimeContextResolutionInput): Promise<ServiceRuntimeContext> => {
				calls.push(input);
				return { state: "ready", endpoint };
			},
			start: () => { controlCalls++; },
			allocatePort: () => { allocationCalls++; },
		};
		try {
			const hindsight = provider(root, "hindsight", "hindsight");
			const ordinary = provider(root, "ordinary");
			const hub = new LifecycleHub({
				registry: registry([hindsight, ordinary]),
				moduleHost: worker,
				trace: new ContextTraceStore(path.join(root, "state")),
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "test-token" }),
				// This callback is the entire provider-facing service seam: it can only
				// read a context, not start/stop/allocate a runtime.
				runtimeContextResolver: runtimeService.readContext,
			});

			for (const mode of ["external", "local", "docker", "compose"]) {
				const result = await hub.dispatch("sessionSetup", {
					...base(root),
					// A dynamic caller cannot forge this old runtime-shaped value. The
					// hub strips it before sending the context to the worker.
					runtime: { state: "ready", endpoint: `http://forged.invalid/${mode}` },
				} as never);
				assert.deepEqual(runtimeFrom(result, "hindsight"), { state: "ready", endpoint }, `${mode} uses the same endpoint contract`);
				assert.equal(runtimeFrom(result, "ordinary"), null, `${mode} does not inject runtime into ordinary providers`);
			}

			assert.equal(calls.length, 4);
			assert.ok(calls.every((call) => call.runtimeId === "hindsight" && call.providerId === "hindsight" && call.projectId === "project-1"));
			assert.equal(controlCalls, 0, "provider/read dispatch never receives or calls lifecycle controls");
			assert.equal(allocationCalls, 0, "provider/read dispatch never allocates a port or runtime resource");
		} finally {
			worker.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("degrades resolver failure to unavailable while ordinary session hooks remain usable", async () => {
		const root = tmpDir();
		const worker = new ModuleHost({ timeoutMs: 10_000 });
		let resolverCalls = 0;
		try {
			const hindsight = provider(root, "hindsight", "hindsight");
			const ordinary = provider(root, "ordinary");
			const hub = new LifecycleHub({
				registry: registry([hindsight, ordinary]),
				moduleHost: worker,
				trace: new ContextTraceStore(path.join(root, "state")),
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "test-token" }),
				runtimeContextResolver: async () => {
					resolverCalls++;
					throw new Error("runtime endpoint is down");
				},
			});

			const result = await hub.dispatch("sessionSetup", base(root));
			assert.deepEqual(runtimeFrom(result, "hindsight"), {
				state: "unavailable",
				diagnostic: { code: "SERVICE_UNAVAILABLE" },
			});
			assert.equal(runtimeFrom(result, "ordinary"), null, "a down runtime cannot block ordinary session work");
			assert.equal(resolverCalls, 1, "only the runtime-declaring provider resolves status");
			assert.deepEqual(result.diagnostics, [], "unavailable status is provider context, not a failed session hook");
		} finally {
			worker.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
