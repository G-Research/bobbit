// exact-registered partition for the deliberate ModuleHost worker OOM.
import { guardProcessEnv } from "../core/_helpers/env-guard.js";
import { enableTsWorkerResolver } from "../core/_helpers/enable-ts-worker.js";
guardProcessEnv();
enableTsWorkerResolver();

import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ModuleHost, type InvokeRequest } from "../../../src/server/extension-host/module-host-worker.ts";
import { ActionError, type ActionHandlerCtx } from "../../../src/server/extension-host/action-dispatcher.ts";
import { makeTmpDir } from "../../support/helpers/shared/tmp.ts";

let tmp: string;

const bareCtx = (): ActionHandlerCtx => ({
	host: {} as ActionHandlerCtx["host"],
	sessionId: "sess-1",
	toolUseId: "tu-1",
	tool: "demo_tool",
});

function req(url: string, member: string, ctx: ActionHandlerCtx): InvokeRequest {
	return { url, packRoot: tmp, epoch: 0, exportKind: "actions", member, ctx, arg: {} };
}

beforeAll(() => {
	tmp = makeTmpDir("ext-host-memory-iso-");
});

afterAll(() => {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

// This test deliberately crashes a 16 MB ModuleHost worker. Keep it in its own
// exact-registered v2-isolated file so the parent fork never also hosts the broad
// concurrent worker-thread fan-out in extension-host-module-isolation.test.ts.
describe("ModuleHost — memory cap (resourceLimits)", () => {
	it("a handler that exceeds the heap cap crashes the worker → ActionError, not an unbounded parent alloc", async () => {
		// Tight heap cap; a generous timeout so the OOM (not the timer) is what fires.
		const mh = new ModuleHost({ timeoutMs: 15_000, maxOldGenerationSizeMb: 16 });
		try {
			const file = path.join(tmp, "memory-hog.mjs");
			fs.writeFileSync(file, `export const actions = { hog: async () => { const a = []; for (;;) { a.push(new Array(1e6).fill(7)); } } };`);
			const url = pathToFileURL(file).href;
			await assert.rejects(
				() => mh.invoke(req(url, "hog", bareCtx())),
				(e) => e instanceof ActionError && /memory|heap/i.test(e.message),
			);
		} finally {
			mh.dispose();
		}
	});
});
