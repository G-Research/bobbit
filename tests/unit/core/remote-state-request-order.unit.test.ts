import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	RemoteStateRequestOrder,
	remoteStateRequestKey,
} from "../../../src/app/remote-state-request-order.ts";

describe("RemoteStateRequestOrder", () => {
	it("rejects a REST ticket superseded by an accepted completion", () => {
		const order = new RemoteStateRequestOrder();
		const key = remoteStateRequestKey("dashboard", "goal-1", "pr");
		const ticket = order.begin(key);

		assert.equal(order.isCurrent(ticket), true);
		order.supersede(key);
		assert.equal(order.isCurrent(ticket), false);
	});

	it("lets a newer request supersede an older request for the same projection", () => {
		const order = new RemoteStateRequestOrder();
		const key = remoteStateRequestKey("session", "session-1", "git");
		const older = order.begin(key);
		const newer = order.begin(key);

		assert.equal(order.isCurrent(older), false);
		assert.equal(order.isCurrent(newer), true);
	});

	it("keeps surfaces, owners, and Git/PR resources independent", () => {
		const order = new RemoteStateRequestOrder();
		const dashboardPr = order.begin(remoteStateRequestKey("dashboard", "goal-1", "pr"));
		const dashboardGit = order.begin(remoteStateRequestKey("dashboard", "goal-1", "git"));
		const otherGoalPr = order.begin(remoteStateRequestKey("dashboard", "goal-2", "pr"));
		const sidebarPr = order.begin(remoteStateRequestKey("sidebar", "goal-1", "pr"));

		order.supersede(dashboardPr.key);

		assert.equal(order.isCurrent(dashboardPr), false);
		assert.equal(order.isCurrent(dashboardGit), true);
		assert.equal(order.isCurrent(otherGoalPr), true);
		assert.equal(order.isCurrent(sidebarPr), true);
	});
});
