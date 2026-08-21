import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";

import { guardProcessEnv } from "./helpers/env-guard.js";
import { generateToolResultErrorBridgeExtension } from "../../src/server/agent/tool-result-error-bridge-extension.ts";

guardProcessEnv();

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const originalEnv = {
	gateway: process.env.BOBBIT_GATEWAY_URL,
	session: process.env.BOBBIT_SESSION_ID,
	token: process.env.BOBBIT_TOKEN,
	hooks: process.env.BOBBIT_HOST_HOOKS_ENABLED,
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries({
		BOBBIT_GATEWAY_URL: originalEnv.gateway,
		BOBBIT_SESSION_ID: originalEnv.session,
		BOBBIT_TOKEN: originalEnv.token,
		BOBBIT_HOST_HOOKS_ENABLED: originalEnv.hooks,
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
	process.env.BOBBIT_HOST_HOOKS_ENABLED = "1";
}

describe("Pi host tool interceptor ordering", () => {
	it("runs permission, beforeToolCall mutation, handler, then afterToolResult mutation", async () => {
		installHostEnv();
		const order: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const pathname = new URL(String(url)).pathname;
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
				assert.match(error.message, /policy_denied/);
				assert.doesNotMatch(error.message, /PRIVATE_POLICY_REASON|PRIVATE_ARGS/);
				return true;
			},
		);
		assert.equal(handlerCalled, false);
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
