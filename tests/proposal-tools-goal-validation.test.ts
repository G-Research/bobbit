/**
 * Tool-level test — `propose_goal` surfaces the server's workflow-validation
 * rejection as an `isError` result, instead of a silent "Proposal submitted"
 * ack.
 *
 * See docs/design — "Validate goal workflow at proposal time" (Requirement 1,
 * tool surfacing). The seed endpoint returns a structured 400 body
 * `{ ok:false, code:"UNKNOWN_WORKFLOW", message, availableWorkflows }` when an
 * agent names a workflow the project doesn't have; the agent must SEE that
 * message (with the corrective list) rather than a false success.
 *
 * Contract pinned:
 *   - propose_goal.execute → isError:true, text carries the server `message`.
 *   - propose_goal happy path → ack with `__proposal_rev_v1__:<rev>`.
 *   - other propose_* (e.g. propose_role) keep ack-on-error (log-and-ack).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import registerProposalExtension from "../defaults/tools/proposals/extension.ts";

type ExecuteFn = (toolUseId: string, params: unknown) => Promise<any>;

function makeStubApi(): { api: any; get: (name: string) => ExecuteFn } {
	const map = new Map<string, ExecuteFn>();
	const api = {
		registerTool(config: any) {
			if (config?.name && typeof config?.execute === "function") {
				map.set(config.name, config.execute.bind(config));
			}
		},
	};
	return {
		api,
		get: (name: string) => {
			const fn = map.get(name);
			if (!fn) throw new Error(`tool not registered: ${name}`);
			return fn;
		},
	};
}

function textOf(result: any): string {
	const item = result?.content?.[0];
	return typeof item?.text === "string" ? item.text : "";
}

/** Build a minimal Response-like object for the global.fetch stub. */
function fakeResponse(status: number, body: unknown): any {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	return { status, async text() { return text; } };
}

describe("propose_goal — surfaces workflow validation rejection", () => {
	let getExecute: (name: string) => ExecuteFn;
	const saved: Record<string, string | undefined> = {};
	const realFetch = globalThis.fetch;

	before(() => {
		for (const k of ["BOBBIT_SESSION_ID", "BOBBIT_GATEWAY_URL", "BOBBIT_TOKEN"]) {
			saved[k] = process.env[k];
		}
		process.env.BOBBIT_SESSION_ID = "sess-1";
		process.env.BOBBIT_GATEWAY_URL = "http://gateway.invalid";
		process.env.BOBBIT_TOKEN = "tok";
		const { api, get } = makeStubApi();
		registerProposalExtension(api);
		getExecute = get;
	});

	after(() => {
		for (const k of Object.keys(saved)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		globalThis.fetch = realFetch;
	});

	it("returns isError with the server message + available workflows on 400", async () => {
		globalThis.fetch = (async () => fakeResponse(400, {
			ok: false,
			code: "UNKNOWN_WORKFLOW",
			message: 'Unknown workflow "nope". Available workflows for this project: general, feature, bug-fix.',
			availableWorkflows: [{ id: "general", name: "General" }, { id: "feature", name: "Feature" }],
		})) as any;

		const result = await getExecute("propose_goal")("tu-1", { title: "G", spec: "s", workflow: "nope" });
		assert.equal(result?.isError, true, "rejection must surface as isError");
		const text = textOf(result);
		assert.match(text, /Unknown workflow/);
		assert.match(text, /general, feature, bug-fix/);
		// Must NOT masquerade as a successful submission.
		assert.doesNotMatch(text, /Proposal submitted/);
		assert.doesNotMatch(text, /__proposal_rev_v1__/);
	});

	it("returns the normal ack with rev contract on success (200)", async () => {
		globalThis.fetch = (async () => fakeResponse(200, { ok: true, rev: 7 })) as any;

		const result = await getExecute("propose_goal")("tu-2", { title: "G", spec: "s", workflow: "feature" });
		assert.notEqual(result?.isError, true, "success must not be an error");
		const text = textOf(result);
		assert.match(text, /Proposal submitted/);
		assert.match(text, /__proposal_rev_v1__:7/);
	});

	it("other propose_* tools keep ack-on-error (log-and-ack)", async () => {
		globalThis.fetch = (async () => fakeResponse(400, {
			ok: false, code: "SOME_ERROR", message: "nope",
		})) as any;

		const result = await getExecute("propose_role")("tu-3", { name: "r", label: "R", prompt: "p" });
		assert.notEqual(result?.isError, true, "propose_role keeps current log-and-ack behaviour");
		assert.match(textOf(result), /Proposal submitted/);
	});
});
