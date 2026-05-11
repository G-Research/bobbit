/**
 * Unit tests for the VerifyHandlerRegistry — the dispatch substrate that
 * lets plugins register new verify-step types alongside the built-in
 * command/llm-review/agent-qa branches.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	VerifyHandlerRegistry,
	unknownTypeFailureResult,
	type VerifyHandler,
	type VerifyExecCtx,
} from "../src/server/agent/verify-handlers/registry.ts";

function makeHandler(type: string, passed: boolean, output: string): VerifyHandler {
	return {
		type,
		async execute() {
			return { passed, output };
		},
	};
}

describe("VerifyHandlerRegistry", () => {
	it("registers and retrieves a handler by type", () => {
		const r = new VerifyHandlerRegistry();
		const h = makeHandler("external-job", true, "ok");
		r.register(h);
		assert.equal(r.has("external-job"), true);
		assert.equal(r.get("external-job"), h);
	});

	it("returns undefined for unknown types", () => {
		const r = new VerifyHandlerRegistry();
		assert.equal(r.has("unknown"), false);
		assert.equal(r.get("unknown"), undefined);
	});

	it("re-registering the same type overwrites the prior handler", () => {
		const r = new VerifyHandlerRegistry();
		const a = makeHandler("rubric-review", true, "a");
		const b = makeHandler("rubric-review", false, "b");
		r.register(a);
		r.register(b);
		assert.equal(r.get("rubric-review"), b);
	});

	it("unregister removes the handler", () => {
		const r = new VerifyHandlerRegistry();
		r.register(makeHandler("tool-call", true, "ok"));
		r.unregister("tool-call");
		assert.equal(r.has("tool-call"), false);
	});

	it("types() lists all registered handler types", () => {
		const r = new VerifyHandlerRegistry();
		r.register(makeHandler("external-job", true, ""));
		r.register(makeHandler("rubric-review", true, ""));
		assert.deepEqual(r.types().sort(), ["external-job", "rubric-review"]);
	});

	it("handler execute returns a VerifyStepResult", async () => {
		const r = new VerifyHandlerRegistry();
		r.register({
			type: "noop",
			async execute(_ctx: VerifyExecCtx, _step) {
				return { passed: true, output: "noop ran", artifact: { content: "x", contentType: "text/markdown" } };
			},
		});
		const h = r.get("noop");
		assert.ok(h, "handler should be registered");
		const ctx: VerifyExecCtx = {
			goalId: "g1",
			gateId: "gate-1",
			signalId: "sig-1",
			signal: {} as any,
			gate: {} as any,
			cwd: "/tmp",
			branch: "x",
			primaryBranch: "master",
			builtinVars: {},
			projectVars: {},
			agentVars: {},
			substituteVars: (t: string) => t,
			broadcast: () => {},
			persistActive: () => {},
			isCancelled: () => false,
		};
		const out = await h.execute(ctx, { name: "n", type: "noop" } as any);
		assert.equal(out.passed, true);
		assert.equal(out.output, "noop ran");
		assert.equal(out.artifact?.contentType, "text/markdown");
	});
});

describe("unknownTypeFailureResult", () => {
	it("produces a failed result naming the unknown type", () => {
		const r = unknownTypeFailureResult("my-custom-type");
		assert.equal(r.passed, false);
		assert.match(r.output, /my-custom-type/);
		assert.match(r.output, /No handler registered/);
	});
});
