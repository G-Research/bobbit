import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { generateToolGuardExtension } from "../../src/server/agent/tool-guard-extension.ts";
import {
	InProcessMockBridge,
	createInProcessMockExtensionCache,
} from "../../tests/e2e/in-process-mock-bridge.mjs";

type RecordedRequest = { path: string; authorization: string };

type GuardHarness = ReturnType<typeof createGuardHarness>;

const pathApi = {
	join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
};
const osApi = { homedir: () => "/home/bobbit-test" };

function createGuardHarness() {
	const files = new Map<string, string>();
	const versions = new Map<string, string>();
	const requests: RecordedRequest[] = [];
	const memoryFs = {
		readFileSync(filePath: unknown) {
			const normalized = String(filePath);
			const contents = files.get(normalized);
			if (contents !== undefined) return contents;
			throw Object.assign(new Error(`ENOENT: no such file or directory, open '${normalized}'`), { code: "ENOENT" });
		},
	};
	const httpModule = {
		request(url: URL, options: { headers?: Record<string, string> }, onResponse: (response: unknown) => void) {
			return {
				on() { return this; },
				write() {},
				end() {
					requests.push({
						path: url.pathname,
						authorization: String(options.headers?.Authorization ?? ""),
					});
					queueMicrotask(() => onResponse({
						on(event: string, handler: (value?: string) => void) {
							if (event === "data") handler(JSON.stringify({ granted: false, reason: "canary denial" }));
							if (event === "end") handler();
							return this;
						},
					}));
				},
			};
		},
	};
	const cache = createInProcessMockExtensionCache({
		versionFor: async (filePath: string) => versions.get(filePath) ?? "missing",
		loadModule: async (filePath: string) => compileGuardModule(
			files.get(filePath) ?? "",
			memoryFs,
			httpModule,
		),
	});

	return {
		cache,
		requests,
		setGuard(filePath: string, source: string, version = "1") {
			files.set(filePath, source);
			versions.set(filePath, version);
		},
	};
}

function compileGuardModule(
	source: string,
	memoryFs: { readFileSync(filePath: unknown): string },
	httpModule: unknown,
) {
	const transformed = source
		.replace('import * as fs from "node:fs";\n', "")
		.replace('import * as path from "node:path";\n', "")
		.replace('import * as os from "node:os";\n', "")
		.replace("export default function(pi) {", "return function(pi) {")
		.replace(
			'url.protocol === "https:" ? await import("node:https") : await import("node:http")',
			'url.protocol === "https:" ? httpModules.https : httpModules.http',
		);
	if (!transformed.trimStart().startsWith("return function(pi) {") || transformed.includes("await import(")) {
		throw new Error("Generated tool guard shape changed; update the in-memory loader");
	}
	const activate = Function("fs", "path", "os", "httpModules", transformed)(
		memoryFs,
		pathApi,
		osApi,
		{ http: httpModule, https: httpModule },
	);
	return { default: activate };
}

function makeBridge(
	harness: GuardHarness,
	guardPath: string,
	env: Record<string, string>,
) {
	return new InProcessMockBridge({
		args: ["--extension", guardPath],
		env,
		extensionModuleCache: harness.cache,
	});
}

describe("in-process mock shared tool-guard module", () => {
	it("keeps session identity and token isolated for later and concurrent callbacks", async () => {
		const harness = createGuardHarness();
		const guardPath = "/state/tool-guard/shared-policy/guard.ts";
		harness.setGuard(guardPath, generateToolGuardExtension(
			"not-embedded",
			{ guarded_probe: { policy: "ask", group: "canary" } },
			[],
		));

		const makeSessionBridge = (sessionId: string, token: string) => makeBridge(harness, guardPath, {
			BOBBIT_DIR: "/bobbit",
			BOBBIT_GATEWAY_URL: "http://gateway.test",
			BOBBIT_SESSION_ID: sessionId,
			BOBBIT_TOKEN: token,
		});
		const first = makeSessionBridge("session-first", "token-first");
		const second = makeSessionBridge("session-second", "token-second");

		try {
			// Concurrent activation must share the immutable module while invoking
			// its factory once per session to create isolated closures.
			await Promise.all([first.start(), second.start()]);
			assert.deepEqual(harness.cache.stats(guardPath), { entries: 1, loads: 1 });

			const firstHandler = (first as any)._agent.mockPiToolCallHandlers[0];
			const secondHandler = (second as any)._agent.mockPiToolCallHandlers[0];
			assert.equal(typeof firstHandler, "function");
			assert.equal(typeof secondHandler, "function");

			// Invoke after both activations have completed: neither callback may read
			// the other activation's process-global env.
			await firstHandler({ toolName: "guarded_probe" });
			await secondHandler({ toolName: "guarded_probe" });
			assert.deepEqual(harness.requests.slice(0, 2), [
				{ path: "/api/sessions/session-first/tool-grant-request", authorization: "Bearer token-first" },
				{ path: "/api/sessions/session-second/tool-grant-request", authorization: "Bearer token-second" },
			]);

			// Concurrent callbacks must retain the same isolation.
			await Promise.all([
				firstHandler({ toolName: "guarded_probe" }),
				secondHandler({ toolName: "guarded_probe" }),
			]);
			assert.deepEqual(
				harness.requests.slice(2).sort((a, b) => a.path.localeCompare(b.path)),
				[
					{ path: "/api/sessions/session-first/tool-grant-request", authorization: "Bearer token-first" },
					{ path: "/api/sessions/session-second/tool-grant-request", authorization: "Bearer token-second" },
				],
			);

			// A changed caller-owned version key must load a fresh declaration while
			// leaving the already-activated session closures untouched.
			harness.setGuard(guardPath, generateToolGuardExtension(
				"not-embedded",
				{ guarded_probe: { policy: "ask", group: "canary" } },
				[],
			), "2");
			const refreshed = makeSessionBridge("session-refreshed", "token-refreshed");
			await refreshed.start();
			assert.deepEqual(harness.cache.stats(guardPath), { entries: 2, loads: 2 });
			await refreshed.stop();
		} finally {
			await Promise.all([first.stop(), second.stop()]);
		}
	});

	it("activates never policies without gateway credentials and fails ask policies closed", async () => {
		const harness = createGuardHarness();
		const guardPath = "/state/tool-guard/credentialless-policy/guard.ts";
		harness.setGuard(guardPath, generateToolGuardExtension(
			"not-embedded",
			{
				forbidden_probe: { policy: "never", group: "canary" },
				guarded_probe: { policy: "ask", group: "canary" },
			},
			[],
		));

		const previousGatewayUrl = process.env.BOBBIT_GATEWAY_URL;
		const previousToken = process.env.BOBBIT_TOKEN;
		delete process.env.BOBBIT_GATEWAY_URL;
		delete process.env.BOBBIT_TOKEN;
		const bridge = makeBridge(harness, guardPath, {
			BOBBIT_DIR: "/credentialless",
			BOBBIT_SESSION_ID: "credentialless-session",
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
		}
	});
});
