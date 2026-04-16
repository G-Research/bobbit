/**
 * Tier 2 contract tests for the gate verification pipeline.
 *
 * Each test gets a fresh in-process gateway. No browser, no spawned processes,
 * no retries — just the actual verification code running in isolation.
 *
 * These tests replace the flaky equivalents in:
 *   tests/e2e/gates-api-heavy.spec.ts
 *   tests/e2e/gate-resign-cancel.spec.ts
 */
import { test } from "node:test";
import assert from "node:assert";
import { createTestGateway } from "./fixtures/gateway.js";

async function apiFetch(gw: any, path: string, opts: { method?: string; body?: any } = {}): Promise<any> {
	const res = await fetch(`${gw.baseURL}${path}`, {
		method: opts.method || "GET",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${gw.token}`,
		},
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function waitForGateStatus(
	gw: any,
	goalId: string,
	gateId: string,
	status: string,
	timeoutMs = 5000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(gw, `/api/goals/${goalId}/gates/${gateId}`);
		if (res.body?.status === status) return;
		await new Promise(r => setTimeout(r, 20));
	}
	const final = await apiFetch(gw, `/api/goals/${goalId}/gates/${gateId}`);
	throw new Error(`Gate ${gateId} did not reach "${status}" in ${timeoutMs}ms (last status: ${final.body?.status})`);
}

test("cascade reset — re-signaling upstream resets downstream", async () => {
	const t0 = Date.now();
	await using gw = await createTestGateway({ startHttp: true });
	const t1 = Date.now();

	const goalRes = await apiFetch(gw, "/api/goals", {
		method: "POST",
		body: { title: "Cascade Reset Test", cwd: gw.dir, team: false, workflowId: "test-fast" },
	});
	assert.equal(goalRes.status, 201, `Goal creation failed: ${JSON.stringify(goalRes.body)}`);
	const goalId = goalRes.body.id;
	const t2 = Date.now();

	const s1 = await apiFetch(gw, `/api/goals/${goalId}/gates/design-doc/signal`, {
		method: "POST",
		body: { content: "# Design v1" },
	});
	assert.equal(s1.status, 201);
	await waitForGateStatus(gw, goalId, "design-doc", "passed");
	const t3 = Date.now();

	const s2 = await apiFetch(gw, `/api/goals/${goalId}/gates/implementation/signal`, {
		method: "POST",
		body: {},
	});
	assert.equal(s2.status, 201);
	await waitForGateStatus(gw, goalId, "implementation", "passed");
	const t4 = Date.now();

	const s3 = await apiFetch(gw, `/api/goals/${goalId}/gates/design-doc/signal`, {
		method: "POST",
		body: { content: "# Design v2" },
	});
	assert.equal(s3.status, 201);
	await waitForGateStatus(gw, goalId, "design-doc", "passed");
	const t5 = Date.now();

	const gatesRes = await apiFetch(gw, `/api/goals/${goalId}/gates`);
	const impl = gatesRes.body.gates.find((g: any) => g.gateId === "implementation");
	assert.equal(impl?.status, "pending", "implementation gate should reset after upstream re-signal");

	console.log(`\n  gateway=${t1-t0}ms goal=${t2-t1}ms sig1+verify=${t3-t2}ms sig2+verify=${t4-t3}ms sig3+verify=${t5-t4}ms`);
});

test("gate with unmet upstream dependency is rejected (409)", async () => {
	await using gw = await createTestGateway({ startHttp: true });

	const goalRes = await apiFetch(gw, "/api/goals", {
		method: "POST",
		body: { title: "Dep Test", cwd: gw.dir, team: false, workflowId: "test-fast" },
	});
	assert.equal(goalRes.status, 201);
	const goalId = goalRes.body.id;

	// Try to signal implementation without signaling design-doc first → 409
	const res = await apiFetch(gw, `/api/goals/${goalId}/gates/implementation/signal`, {
		method: "POST",
		body: {},
	});
	assert.equal(res.status, 409);
	assert.match(res.body.error, /design-doc|Upstream gate/i);
});

test("unknown gate returns 404", async () => {
	await using gw = await createTestGateway({ startHttp: true });

	const goalRes = await apiFetch(gw, "/api/goals", {
		method: "POST",
		body: { title: "Unknown Gate Test", cwd: gw.dir, team: false, workflowId: "test-fast" },
	});
	const goalId = goalRes.body.id;

	const res = await apiFetch(gw, `/api/goals/${goalId}/gates/nonexistent/signal`, {
		method: "POST",
		body: {},
	});
	assert.equal(res.status, 404);
});
