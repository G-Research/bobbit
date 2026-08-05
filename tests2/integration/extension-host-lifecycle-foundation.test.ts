import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enableTsWorkerResolver } from "../core/helpers/enable-ts-worker.ts";
import { ModuleHost, type InvokeRequest } from "../../src/server/extension-host/module-host-worker.ts";

enableTsWorkerResolver();
beforeAll(() => { enableTsWorkerResolver(); });

function fixtureRoot(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "extension-host-lifecycle-")));
}

describe("extension-host lifecycle foundation", () => {
	it("forwards the host-owned deadline as worker-local deadline metadata and AbortSignal", async () => {
		const root = fixtureRoot();
		const file = path.join(root, "provider.mjs");
		fs.writeFileSync(file, `export default { async sessionSetup(ctx) {
			return { hasSignal: !!ctx.signal && typeof ctx.signal.aborted === "boolean", deadlineEpochMs: ctx.deadline?.deadlineEpochMs, remaining: ctx.deadline?.remainingMs() };
		} };`);
		const deadlineEpochMs = Date.now() + 5_000;
		const host = new ModuleHost({ timeoutMs: 10_000 });
		try {
			const result = await host.invoke({
				url: new URL(`file://${file}`).href,
				packRoot: root,
				epoch: 0,
				exportKind: "providers",
				member: "sessionSetup",
				ctx: { sessionId: "session-1", tool: "provider", capabilities: { callRoute: false, session: false, store: false, agents: false } } as unknown as InvokeRequest["ctx"],
				arg: undefined,
				workingDir: root,
				deadlineEpochMs,
			}, { deadlineEpochMs }) as { hasSignal: boolean; deadlineEpochMs: number; remaining: number };
			expect(result.hasSignal).toBe(true);
			expect(result.deadlineEpochMs).toBe(deadlineEpochMs);
			expect(result.remaining).toBeGreaterThan(0);
		} finally {
			host.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
