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

function request(url: string, member: "decide" | "onDecision", ctx: DecisionHookContext | DecisionResolutionContext = context()): InvokeRequest<DecisionHookContext | DecisionResolutionContext> {
	return { url, packRoot: tmp, epoch: 0, exportKind: "hooks", member, ctx, arg: undefined, workingDir: tmp };
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
				capabilities: { callRoute: false, session: false, store: false, agents: false },
			});
		} finally {
			host.dispose();
		}
	});

	it("permits only decide and onDecision own functions", async () => {
		const host = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const url = writeHook(`export const decide = () => "initial"; export const onDecision = (ctx) => ctx.resolution.reason; export const unrelated = () => "no";`);
			await expect(host.invoke(request(url, "decide"))).resolves.toBe("initial");
			await expect(host.invoke(request(url, "onDecision", {
				...context(),
				requestId: "request-1",
				resolution: { value: { kind: "option", value: "quick" }, actor: "user", reason: "answered" },
			}))).resolves.toBe("answered");
			await expect(host.invoke({ ...request(url, "decide"), member: "unrelated" })).rejects.toMatchObject({ status: 404 });
		} finally {
			host.dispose();
		}
	});
});
