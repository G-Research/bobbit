/**
 * Reproducing test for the "Minimal error widget on ask failure" bug.
 *
 * `defaults/tools/ask/extension.ts::execute()` validates `tab_label` on
 * multi-question asks and, on failure, returns `ok({ error: "..." })`. The
 * `ok()` helper does NOT set `isError: true`, so the UI renderer treats the
 * result as a success and renders the full interactive widget instead of a
 * minimal error chip.
 *
 * This test asserts that the two validation-failure paths return a result
 * with `result.isError === true`. The failing-case assertions below WILL FAIL
 * on master — that is the point of this reproducing test. They will pass once
 * the extension is fixed to set `isError: true` on validation failures.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import registerAskExtension from "../defaults/tools/ask/extension.ts";

type ExecuteFn = (toolUseId: string, params: unknown) => Promise<any>;

function makeStubApi(): { api: any; getExecute: () => ExecuteFn } {
	let captured: ExecuteFn | null = null;
	const api = {
		registerTool(config: any) {
			if (typeof config?.execute === "function") {
				captured = config.execute.bind(config);
			}
		},
	};
	return {
		api,
		getExecute: () => {
			if (!captured) throw new Error("execute was not registered");
			return captured;
		},
	};
}

function textOf(result: any): string {
	const item = result?.content?.[0];
	return typeof item?.text === "string" ? item.text : "";
}

describe("ask extension execute — validation error shape", () => {
	let execute: ExecuteFn;
	let prevSessionId: string | undefined;

	before(() => {
		prevSessionId = process.env.BOBBIT_SESSION_ID;
		process.env.BOBBIT_SESSION_ID = "test-session";
		const { api, getExecute } = makeStubApi();
		registerAskExtension(api);
		execute = getExecute();
	});

	after(() => {
		if (prevSessionId === undefined) delete process.env.BOBBIT_SESSION_ID;
		else process.env.BOBBIT_SESSION_ID = prevSessionId;
	});

	it("returns a posted stub (not an error) for a valid multi-question ask", async () => {
		const result = await execute("tool-use-id", {
			questions: [
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
			],
		});
		assert.notEqual(result?.isError, true, "valid ask should not have isError:true");
		const body = JSON.parse(textOf(result));
		assert.deepEqual(body, { status: "posted", tool_use_id: "tool-use-id" });
	});

	it("sets isError:true when tab_label is missing on questions[1]", async () => {
		const result = await execute("tool-use-id", {
			questions: [
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"] },
			],
		});
		assert.equal(result?.isError, true, "missing tab_label should set isError:true");
		const text = textOf(result);
		assert.match(text, /tab_label/);
		assert.match(text, /\[1\]/);
	});

	it("sets isError:true when tab_label exceeds 24 chars on questions[1]", async () => {
		const longLabel = "x".repeat(25);
		const result = await execute("tool-use-id", {
			questions: [
				{ question: "Q1", options: ["a", "b"], tab_label: "First" },
				{ question: "Q2", options: ["c", "d"], tab_label: longLabel },
			],
		});
		assert.equal(result?.isError, true, "overlong tab_label should set isError:true");
		const text = textOf(result);
		assert.match(text, /24/);
	});
});
