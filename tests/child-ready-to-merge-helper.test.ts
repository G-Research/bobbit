/**
 * Pure helper tests for `adaptReadyToMergeVerify` / `adaptReadyToMergeForChild`.
 * See `src/server/agent/child-ready-to-merge.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	adaptReadyToMergeVerify,
	adaptReadyToMergeForChild,
} from "../src/server/agent/child-ready-to-merge.ts";
import type { VerifyStep, Workflow } from "../src/server/agent/workflow-store.ts";

const ROOT_RTM_VERIFY: VerifyStep[] = [
	{
		name: "Branch pushed to remote",
		type: "command",
		run: "git push origin {{branch}}",
	},
	{
		name: "Master merged into branch",
		type: "command",
		run: "git fetch origin master && git merge origin/master --no-edit",
	},
	{
		name: "PR raised",
		type: "command",
		run: "gh pr view {{branch}}",
	},
];

const PARENT_BRANCH = "goal/parent-example-deadbeef";

function rootWorkflow(verify: VerifyStep[] = ROOT_RTM_VERIFY): Workflow {
	return {
		id: "feature",
		name: "Feature",
		description: "",
		gates: [
			{ id: "execution", name: "Execution", dependsOn: [] },
			{
				id: "ready-to-merge",
				name: "Ready to Merge",
				dependsOn: ["execution"],
				verify,
			},
		],
		createdAt: 0,
		updatedAt: 0,
	};
}

describe("adaptReadyToMergeVerify", () => {
	it("replaces 'Master merged into branch' with parent-branch echo", () => {
		const out = adaptReadyToMergeVerify(ROOT_RTM_VERIFY, { parentBranch: PARENT_BRANCH });
		const step = out.find(s => s.name === "Master merged into branch");
		assert.ok(step);
		assert.equal(step.type, "command");
		assert.match(step.run ?? "", /^echo 'child goal —/);
		assert.match(step.run ?? "", new RegExp(PARENT_BRANCH));
	});

	it("replaces 'PR raised' with the no-PR echo", () => {
		const out = adaptReadyToMergeVerify(ROOT_RTM_VERIFY, { parentBranch: PARENT_BRANCH });
		const step = out.find(s => s.name === "PR raised");
		assert.ok(step);
		assert.equal(step.type, "command");
		assert.equal(
			step.run,
			"echo 'child goal — only the root goal raises a PR'",
		);
	});

	it("leaves 'Branch pushed to remote' intact (deep equal)", () => {
		const out = adaptReadyToMergeVerify(ROOT_RTM_VERIFY, { parentBranch: PARENT_BRANCH });
		const before = ROOT_RTM_VERIFY.find(s => s.name === "Branch pushed to remote")!;
		const after = out.find(s => s.name === "Branch pushed to remote")!;
		assert.deepEqual(after, before);
	});

	it("leaves unrelated custom steps intact", () => {
		const custom: VerifyStep[] = [
			{ name: "Custom check", type: "command", run: "echo hi" },
			{ name: "PR raised", type: "command", run: "gh pr view" },
			{ name: "Tests pass", type: "command", run: "npm test" },
		];
		const out = adaptReadyToMergeVerify(custom, { parentBranch: PARENT_BRANCH });
		assert.deepEqual(out[0], custom[0]);
		assert.deepEqual(out[2], custom[2]);
		// PR raised is rewritten
		assert.match(out[1].run ?? "", /^echo 'child goal —/);
	});

	it("preserves step count (replace-not-drop)", () => {
		const out = adaptReadyToMergeVerify(ROOT_RTM_VERIFY, { parentBranch: PARENT_BRANCH });
		assert.equal(out.length, ROOT_RTM_VERIFY.length);
	});

	it("is idempotent — applying twice yields the same shape", () => {
		const once = adaptReadyToMergeVerify(ROOT_RTM_VERIFY, { parentBranch: PARENT_BRANCH });
		const twice = adaptReadyToMergeVerify(once, { parentBranch: PARENT_BRANCH });
		assert.deepEqual(twice, once);
	});
});

describe("adaptReadyToMergeForChild", () => {
	it("rewrites the ready-to-merge gate's verify[]", () => {
		const wf = rootWorkflow();
		const out = adaptReadyToMergeForChild(wf, { parentBranch: PARENT_BRANCH });
		const rtm = out.gates.find(g => g.id === "ready-to-merge");
		assert.ok(rtm?.verify);
		const masterStep = rtm.verify.find(s => s.name === "Master merged into branch");
		assert.match(masterStep?.run ?? "", /^echo 'child goal —/);
	});

	it("does NOT mutate the input workflow", () => {
		const wf = rootWorkflow();
		const before = JSON.stringify(wf);
		adaptReadyToMergeForChild(wf, { parentBranch: PARENT_BRANCH });
		assert.equal(JSON.stringify(wf), before);
	});

	it("returns a deep clone (different object identity)", () => {
		const wf = rootWorkflow();
		const out = adaptReadyToMergeForChild(wf, { parentBranch: PARENT_BRANCH });
		assert.notEqual(out, wf);
		assert.notEqual(out.gates, wf.gates);
		assert.notEqual(out.gates[1], wf.gates[1]);
	});

	it("no-ops cleanly when workflow has no ready-to-merge gate", () => {
		const wf: Workflow = {
			id: "weird",
			name: "Weird",
			description: "",
			gates: [{ id: "execution", name: "Execution", dependsOn: [] }],
			createdAt: 0,
			updatedAt: 0,
		};
		const out = adaptReadyToMergeForChild(wf, { parentBranch: PARENT_BRANCH });
		assert.deepEqual(out, wf);
		// still a deep clone
		assert.notEqual(out, wf);
	});

	it("no-ops cleanly when ready-to-merge gate has no verify[]", () => {
		const wf: Workflow = {
			id: "weird",
			name: "Weird",
			description: "",
			gates: [
				{ id: "execution", name: "Execution", dependsOn: [] },
				{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["execution"] },
			],
			createdAt: 0,
			updatedAt: 0,
		};
		const out = adaptReadyToMergeForChild(wf, { parentBranch: PARENT_BRANCH });
		const rtm = out.gates.find(g => g.id === "ready-to-merge");
		assert.equal(rtm?.verify, undefined);
	});

	it("is idempotent at the workflow level", () => {
		const wf = rootWorkflow();
		const once = adaptReadyToMergeForChild(wf, { parentBranch: PARENT_BRANCH });
		const twice = adaptReadyToMergeForChild(once, { parentBranch: PARENT_BRANCH });
		assert.deepEqual(twice, once);
	});
});
