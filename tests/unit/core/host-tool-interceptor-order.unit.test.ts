import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it, vi } from "vitest";

import { guardProcessEnv } from "../../../tests2/core/helpers/env-guard.js";
import { generateToolResultErrorBridgeExtension } from "../../../src/server/agent/tool-result-error-bridge-extension.ts";

guardProcessEnv();

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const originalEnv = {
	gateway: process.env.BOBBIT_GATEWAY_URL,
	session: process.env.BOBBIT_SESSION_ID,
	token: process.env.BOBBIT_TOKEN,
	hooks: process.env.BOBBIT_HOST_HOOKS_ENABLED,
	sessionSecret: process.env.BOBBIT_SESSION_SECRET,
	beforeFailClosed: process.env.BOBBIT_HOST_BEFORE_TOOL_CALL_FAIL_CLOSED,
	afterFailClosed: process.env.BOBBIT_HOST_AFTER_TOOL_RESULT_FAIL_CLOSED,
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries({
		BOBBIT_GATEWAY_URL: originalEnv.gateway,
		BOBBIT_SESSION_ID: originalEnv.session,
		BOBBIT_TOKEN: originalEnv.token,
		BOBBIT_HOST_HOOKS_ENABLED: originalEnv.hooks,
		BOBBIT_SESSION_SECRET: originalEnv.sessionSecret,
		BOBBIT_HOST_BEFORE_TOOL_CALL_FAIL_CLOSED: originalEnv.beforeFailClosed,
		BOBBIT_HOST_AFTER_TOOL_RESULT_FAIL_CLOSED: originalEnv.afterFailClosed,
	})) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function loadBridge(): Promise<(pi: any) => void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-tool-order-"));
	roots.push(root);
	const file = path.join(root, "bridge.mjs");
	fs.writeFileSync(file, generateToolResultErrorBridgeExtension(), "utf8");
	return (await import(`${pathToFileURL(file).href}?${Date.now()}-${Math.random()}`)).default;
}

function makePi() {
	const listeners = new Map<string, Array<(event: any) => any>>();
	const handlers = new Map<string, Function>();
	const pi: any = {
		on(name: string, handler: (event: any) => any) {
			const rows = listeners.get(name) ?? [];
			rows.push(handler);
			listeners.set(name, rows);
		},
		tool(spec: any, handler?: Function) {
			handlers.set(typeof spec === "string" ? spec : spec.name, handler ?? spec.handler ?? spec.execute);
		},
	};
	return { pi, listeners, handlers };
}

function installHostEnv(): void {
	process.env.BOBBIT_GATEWAY_URL = "http://host-hooks.test";
	process.env.BOBBIT_SESSION_ID = "session-tool-order";
	process.env.BOBBIT_TOKEN = "token";
	process.env.BOBBIT_SESSION_SECRET = "current-session-secret";
	process.env.BOBBIT_HOST_HOOKS_ENABLED = "1";
	process.env.BOBBIT_HOST_BEFORE_TOOL_CALL_FAIL_CLOSED = "0";
}

describe("Pi host tool interceptor ordering", () => {
	it("runs permission, beforeToolCall mutation, handler, then afterToolResult mutation", async () => {
		installHostEnv();
		const order: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const pathname = new URL(String(url)).pathname;
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("X-Bobbit-Session-Secret"), "current-session-secret", "the bridge must bind callbacks to the owning session secret");
			const body = JSON.parse(String(init?.body));
			if (pathname.endsWith("/before-tool-call")) {
				order.push("beforeToolCall");
				assert.equal(body.toolCallId, "call-1");
				assert.equal(body.toolName, "sample");
				return Response.json({ decision: "replaceArgs", args: { value: 2 } });
			}
			order.push("afterToolResult");
			assert.deepEqual(body.result, { content: [{ type: "text", text: "handler:2" }] });
			return Response.json({ decision: "replaceResult", replacement: { content: [{ type: "text", text: "approved" }] } });
		}) as typeof fetch;

		const activate = await loadBridge();
		const { pi, listeners, handlers } = makePi();
		activate(pi);
		// Pi runs tool_call listeners (including Bobbit's permission guard) before
		// invoking the registered handler. The interceptor wrapper is on the latter.
		pi.on("tool_call", async () => { order.push("permission"); return undefined; });
		pi.tool({ name: "sample" }, async (_id: string, args: any) => {
			order.push("handler");
			return { content: [{ type: "text", text: `handler:${args.value}` }] };
		});

		for (const listener of listeners.get("tool_call") ?? []) await listener({ toolCallId: "call-1", toolName: "sample" });
		const result = await handlers.get("sample")!("call-1", { value: 1 });

		assert.deepEqual(order, ["permission", "beforeToolCall", "handler", "afterToolResult"]);
		assert.deepEqual(result, { content: [{ type: "text", text: "approved" }] });
	});

	it("blocks before the handler and uses a constant host-owned error", async () => {
		installHostEnv();
		let handlerCalled = false;
		globalThis.fetch = (async (url: string | URL | Request) => {
			const pathname = new URL(String(url)).pathname;
			assert.ok(pathname.endsWith("/before-tool-call"));
			return Response.json({ decision: "block", reasonCode: "PRIVATE_POLICY_REASON" });
		}) as typeof fetch;

		const activate = await loadBridge();
		const { pi, handlers } = makePi();
		activate(pi);
		pi.tool({ name: "sample" }, async () => {
			handlerCalled = true;
			return { content: [] };
		});

		await assert.rejects(
			() => handlers.get("sample")!("call-block", { secret: "PRIVATE_ARGS" }),
			(error: any) => {
				assert.equal(error.name, "BobbitToolPolicyError");
				assert.match(error.message, /not_permitted/);
				assert.doesNotMatch(error.message, /PRIVATE_POLICY_REASON|PRIVATE_ARGS/);
				return true;
			},
		);
		assert.equal(handlerCalled, false);
	});

	it("blocks with a constant decision when protected beforeToolCall transport fails", async () => {
		const failures: Array<{ name: string; configure: () => void }> = [
			{ name: "disabled", configure: () => { delete process.env.BOBBIT_HOST_HOOKS_ENABLED; } },
			{ name: "missing gateway", configure: () => { delete process.env.BOBBIT_GATEWAY_URL; } },
			{ name: "forbidden", configure: () => { globalThis.fetch = (async () => new Response(null, { status: 403 })) as typeof fetch; } },
			{ name: "missing provenance", configure: () => { globalThis.fetch = (async () => new Response(null, { status: 409 })) as typeof fetch; } },
			{ name: "non-2xx", configure: () => { globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch; } },
			{ name: "malformed", configure: () => { globalThis.fetch = (async () => Response.json({ unexpected: true })) as typeof fetch; } },
			{ name: "unavailable", configure: () => { globalThis.fetch = (async () => { throw new Error("PRIVATE_TRANSPORT_FAILURE"); }) as typeof fetch; } },
		];

		for (const failure of failures) {
			installHostEnv();
			process.env.BOBBIT_HOST_BEFORE_TOOL_CALL_FAIL_CLOSED = "1";
			failure.configure();
			let handlerCalled = false;
			const activate = await loadBridge();
			const { pi, handlers } = makePi();
			activate(pi);
			pi.tool({ name: "sample" }, async () => { handlerCalled = true; return { content: [] }; });

			await assert.rejects(
				() => handlers.get("sample")!(`call-${failure.name}`, { secret: "PRIVATE_ARGS" }),
				(error: any) => {
					assert.equal(error.name, "BobbitToolPolicyError");
					assert.match(error.message, /not_permitted/);
					assert.doesNotMatch(error.message, /PRIVATE_TRANSPORT_FAILURE|PRIVATE_ARGS/);
					return true;
				},
				failure.name,
			);
			assert.equal(handlerCalled, false, failure.name);
			globalThis.fetch = originalFetch;
		}
	});

	it("blocks a protected beforeToolCall when the host callback times out", async () => {
		vi.useFakeTimers();
		try {
			installHostEnv();
			process.env.BOBBIT_HOST_BEFORE_TOOL_CALL_FAIL_CLOSED = "1";
			globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			})) as typeof fetch;
			const activate = await loadBridge();
			const { pi, handlers } = makePi();
			activate(pi);
			pi.tool({ name: "sample" }, async () => ({ content: [] }));

			const invocation = handlers.get("sample")!("call-timeout", {});
			const rejection = assert.rejects(invocation, /not_permitted/);
			await vi.advanceTimersByTimeAsync(2_501);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps an ordinary fail-open beforeToolCall transport failure non-blocking", async () => {
		installHostEnv();
		let handlerCalled = false;
		globalThis.fetch = (async (url: string | URL | Request) => {
			return new URL(String(url)).pathname.endsWith("/before-tool-call")
				? new Response(null, { status: 503 })
				: Response.json({ decision: "allow" });
		}) as typeof fetch;
		const activate = await loadBridge();
		const { pi, handlers } = makePi();
		activate(pi);
		pi.tool({ name: "sample" }, async () => {
			handlerCalled = true;
			return { content: [{ type: "text", text: "ok" }] };
		});

		assert.deepEqual(await handlers.get("sample")!("call-open", {}), { content: [{ type: "text", text: "ok" }] });
		assert.equal(handlerCalled, true);
	});

	it("applies protected synthetic results before Pi persistence", async () => {
		installHostEnv();
		globalThis.fetch = (async (url: string | URL | Request) => {
			const pathname = new URL(String(url)).pathname;
			if (pathname.endsWith("/before-tool-call")) return Response.json({ decision: "allow" });
			return Response.json({ decision: "syntheticError", code: "protected_result" });
		}) as typeof fetch;

		const activate = await loadBridge();
		const { pi, handlers } = makePi();
		activate(pi);
		pi.tool({ name: "sample" }, async () => ({
			content: [{ type: "text", text: "PRIVATE_RESULT_BODY" }],
		}));

		await assert.rejects(
			() => handlers.get("sample")!("call-result", {}),
			(error: any) => {
				assert.equal(error.name, "BobbitToolResultError");
				assert.match(error.message, /protected_result/);
				assert.doesNotMatch(error.message, /PRIVATE_RESULT_BODY/);
				return true;
			},
		);
	});
});
