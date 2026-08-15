import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { guardProcessEnv } from "./helpers/env-guard.js";
import { enableTsWorkerResolver } from "./helpers/enable-ts-worker.js";
import { makeTmpDir } from "../../tests/helpers/tmp.ts";
import { moduleHostBootstrapUrl } from "../../src/server/extension-host/module-host-bootstrap-url.ts";
import { ModuleHost, type InvokeRequest } from "../../src/server/extension-host/module-host-worker.ts";
import type { DecisionHookContext, DecisionResolutionContext } from "../../src/server/agent/decision-hook-contract.ts";

let tmp: string;
let sequence = 0;

guardProcessEnv();
enableTsWorkerResolver();

function writeHook(body: string): string {
	const file = path.join(tmp, `hook-${sequence++}.mjs`);
	fs.writeFileSync(file, body, "utf8");
	return pathToFileURL(file).href;
}

function context(): DecisionHookContext {
	return {
		event: "beforePrompt",
		sessionId: "session-1",
		projectId: "project-1",
		goalId: "goal-1",
		cwd: tmp,
		config: { mode: "review" },
	};
}

function request(url: string, member: "decide" | "onDecision" | "selectSkills" | "selectMcp", ctx: DecisionHookContext | DecisionResolutionContext = context()): InvokeRequest<DecisionHookContext | DecisionResolutionContext> {
	return { url, packRoot: tmp, epoch: 0, exportKind: "hooks", member, ctx, arg: undefined, workingDir: tmp };
}

function filterRequest(url: string): InvokeRequest<Record<string, unknown>> {
	return {
		url, packRoot: tmp, epoch: 0, exportKind: "result-filters", member: "decide", arg: undefined, workingDir: tmp,
		ctx: { event: "afterToolResult", sessionId: "session-1", projectId: "project-1", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "safe-input" }], isError: false } },
	};
}

beforeAll(() => {
	enableTsWorkerResolver();
	tmp = makeTmpDir("decision-hook-worker-");
});
afterAll(() => {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("ModuleHost decision hooks", () => {
	it("resolves the emitted bootstrap under source prebundling", () => {
		const cache = path.join(tmp, "prebundle");
		const runtime = path.join(cache, "entries", "tests2", "harness", "runtime.mjs");
		const output = "entries/src/server/extension-host/module-host-bootstrap.mjs";
		fs.mkdirSync(path.dirname(runtime), { recursive: true });
		fs.writeFileSync(runtime, "", "utf8");
		fs.mkdirSync(path.dirname(path.join(cache, output)), { recursive: true });
		fs.writeFileSync(path.join(cache, output), "", "utf8");
		fs.writeFileSync(path.join(cache, "manifest.json"), JSON.stringify({
			entries: { "src/server/extension-host/module-host-bootstrap.ts": output },
		}), "utf8");

		const sourceUrl = pathToFileURL(path.join(tmp, "src", "module-host-worker.ts")).href;
		expect(moduleHostBootstrapUrl(sourceUrl, runtime).href).toBe(pathToFileURL(path.join(cache, output)).href);
	});

	it("uses the direct/default hook export and exposes no Host API", async () => {
		const host = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeHook(`
				export default {
					decide(ctx) {
						return {
							event: ctx.event,
							sessionId: ctx.sessionId,
							config: ctx.config.mode,
							hasHost: Object.prototype.hasOwnProperty.call(ctx, "host"),
							capabilities: ctx.capabilities,
						};
					}
				};
			`);
			await expect(host.invoke(request(url, "decide"))).resolves.toEqual({
				event: "beforePrompt",
				sessionId: "session-1",
				config: "review",
				hasHost: false,
				capabilities: { callRoute: false, session: false, store: false, agents: false, services: false },
			});
		} finally {
			host.dispose();
		}
	});

	it("runs protected result filters with a credential-free environment and default decide export", async () => {
		const priorToken = process.env.BOBBIT_TOKEN;
		const priorProviderSecret = process.env.EP14_PROVIDER_SECRET;
		process.env.BOBBIT_TOKEN = "EP14_GATEWAY_BEARER_CANARY";
		process.env.EP14_PROVIDER_SECRET = "EP14_PROVIDER_SECRET_CANARY";
		const host = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeHook(`
				export default {
					decide(ctx) {
						return {
							event: ctx.event,
							hasHost: Object.hasOwn(ctx, "host"),
							capabilities: ctx.capabilities,
							token: process.env.BOBBIT_TOKEN ?? null,
							providerSecret: process.env.EP14_PROVIDER_SECRET ?? null,
							path: process.env.PATH ?? process.env.Path ?? null,
							temp: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? null,
						};
					}
				};
			`);
			await expect(host.invoke(filterRequest(url))).resolves.toEqual({
				event: "afterToolResult",
				hasHost: false,
				capabilities: { callRoute: false, session: false, store: false, agents: false, services: false },
				token: null,
				providerSecret: null,
				path: process.env.PATH ?? process.env.Path ?? null,
				temp: process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? null,
			});
		} finally {
			host.dispose();
			if (priorToken === undefined) delete process.env.BOBBIT_TOKEN;
			else process.env.BOBBIT_TOKEN = priorToken;
			if (priorProviderSecret === undefined) delete process.env.EP14_PROVIDER_SECRET;
			else process.env.EP14_PROVIDER_SECRET = priorProviderSecret;
		}
	});

	it("permits exactly the declared decision and selector own functions", async () => {
		const host = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeHook(`
				export const decide = () => "initial";
				export const onDecision = (ctx) => ctx.resolution.reason;
				export const selectSkills = (ctx) => ({ stage: "skills", event: ctx.event });
				export const selectMcp = (ctx) => ({ stage: "mcp", sessionId: ctx.sessionId });
				export const unrelated = () => "no";
			`);
			await expect(host.invoke(request(url, "decide"))).resolves.toBe("initial");
			await expect(host.invoke(request(url, "onDecision", {
				...context(),
				requestId: "request-1",
				resolution: { value: { kind: "option", value: "quick" }, actor: "user", reason: "answered" },
			}))).resolves.toBe("answered");
			await expect(host.invoke(request(url, "selectSkills"))).resolves.toEqual({ stage: "skills", event: "beforePrompt" });
			await expect(host.invoke(request(url, "selectMcp"))).resolves.toEqual({ stage: "mcp", sessionId: "session-1" });
			await expect(host.invoke({ ...request(url, "decide"), member: "unrelated" })).rejects.toMatchObject({ status: 404 });
		} finally {
			host.dispose();
		}
	});
});
