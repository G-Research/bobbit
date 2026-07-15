import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { generateToolGuardExtension } from "../../src/server/agent/tool-guard-extension.ts";
import {
	InProcessMockBridge,
	__inProcessMockExtensionCacheStats,
} from "../../tests/e2e/in-process-mock-bridge.mjs";

describe("in-process mock shared tool-guard module", () => {
	it("keeps session identity and token isolated for later and concurrent callbacks", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-shared-guard-canary-"));
		const guardDir = path.join(tmp, "state", "tool-guard", "shared-policy");
		const guardPath = path.join(guardDir, "guard.ts");
		fs.mkdirSync(guardDir, { recursive: true });
		fs.writeFileSync(guardPath, generateToolGuardExtension(
			"not-embedded",
			{ guarded_probe: { policy: "ask", group: "canary" } },
			[],
		), "utf8");

		const requests: Array<{ path: string; authorization: string }> = [];
		const server = http.createServer((req, res) => {
			requests.push({
				path: req.url ?? "",
				authorization: String(req.headers.authorization ?? ""),
			});
			req.resume();
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ granted: false, reason: "canary denial" }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		const gatewayUrl = `http://127.0.0.1:${port}`;

		const makeBridge = (sessionId: string, token: string) => new InProcessMockBridge({
			args: ["--extension", guardPath],
			env: {
				BOBBIT_DIR: tmp,
				BOBBIT_GATEWAY_URL: gatewayUrl,
				BOBBIT_SESSION_ID: sessionId,
				BOBBIT_TOKEN: token,
			},
		});
		const first = makeBridge("session-first", "token-first");
		const second = makeBridge("session-second", "token-second");

		try {
			// Concurrent activation must share the immutable transpiled module while
			// invoking its factory once per session to create isolated closures.
			await Promise.all([first.start(), second.start()]);
			assert.deepEqual(__inProcessMockExtensionCacheStats(guardPath), { entries: 1, loads: 1 });

			const firstHandler = (first as any)._agent.mockPiToolCallHandlers[0];
			const secondHandler = (second as any)._agent.mockPiToolCallHandlers[0];
			assert.equal(typeof firstHandler, "function");
			assert.equal(typeof secondHandler, "function");

			// Invoke after both activations have completed: neither callback may read
			// the other activation's process-global env.
			await firstHandler({ toolName: "guarded_probe" });
			await secondHandler({ toolName: "guarded_probe" });
			assert.deepEqual(requests.slice(0, 2), [
				{ path: "/api/sessions/session-first/tool-grant-request", authorization: "Bearer token-first" },
				{ path: "/api/sessions/session-second/tool-grant-request", authorization: "Bearer token-second" },
			]);

			// Concurrent callbacks must retain the same isolation.
			await Promise.all([
				firstHandler({ toolName: "guarded_probe" }),
				secondHandler({ toolName: "guarded_probe" }),
			]);
			assert.deepEqual(
				requests.slice(2).sort((a, b) => a.path.localeCompare(b.path)),
				[
					{ path: "/api/sessions/session-first/tool-grant-request", authorization: "Bearer token-first" },
					{ path: "/api/sessions/session-second/tool-grant-request", authorization: "Bearer token-second" },
				],
			);
		} finally {
			await Promise.all([first.stop(), second.stop()]);
			await new Promise<void>((resolve) => server.close(() => resolve()));
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("activates never policies without gateway credentials and fails ask policies closed", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-credentialless-guard-canary-"));
		const guardDir = path.join(tmp, "state", "tool-guard", "credentialless-policy");
		const guardPath = path.join(guardDir, "guard.ts");
		fs.mkdirSync(guardDir, { recursive: true });
		fs.writeFileSync(guardPath, generateToolGuardExtension(
			"not-embedded",
			{
				forbidden_probe: { policy: "never", group: "canary" },
				guarded_probe: { policy: "ask", group: "canary" },
			},
			[],
		), "utf8");

		const previousGatewayUrl = process.env.BOBBIT_GATEWAY_URL;
		const previousToken = process.env.BOBBIT_TOKEN;
		delete process.env.BOBBIT_GATEWAY_URL;
		delete process.env.BOBBIT_TOKEN;
		const bridge = new InProcessMockBridge({
			args: ["--extension", guardPath],
			env: { BOBBIT_DIR: tmp, BOBBIT_SESSION_ID: "credentialless-session" },
		});
		try {
			await bridge.start();
			const handler = (bridge as any)._agent.mockPiToolCallHandlers[0];
			assert.equal(typeof handler, "function", "the security guard must activate without credential files");
			assert.match((await handler({ toolName: "forbidden_probe" })).reason, /not permitted/);
			const askDecision = await handler({ toolName: "guarded_probe" });
			assert.equal(askDecision.block, true);
			assert.match(askDecision.reason, /Failed to request permission/);
		} finally {
			await bridge.stop();
			if (previousGatewayUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL;
			else process.env.BOBBIT_GATEWAY_URL = previousGatewayUrl;
			if (previousToken === undefined) delete process.env.BOBBIT_TOKEN;
			else process.env.BOBBIT_TOKEN = previousToken;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
