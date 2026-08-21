// v2-native — unified Extension Host hook catalogue contract.
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import {
	HOST_HOOK_LIMITS,
	HOST_INTERCEPTOR_CATALOGUE,
	HOST_NOTIFICATION_CATALOGUE,
	HOST_NOTIFICATION_ENVELOPE_SCHEMAS,
	buildHostNotification,
	notificationMatchesFilter,
	validateHostNotification,
	validateInterceptorRequest,
	validateInterceptorResult,
	validateNotificationFilter,
	validateNotificationPayload,
	type HostInterceptorName,
	type HostNotificationName,
} from "../../src/shared/extension-host/host-hooks.ts";

const payloads: Record<HostNotificationName, unknown> = {
	statusChanged: { previousStatus: "starting", status: "idle", statusVersion: 1 },
	turnStarted: { turnIndex: 2, source: "user" },
	turnCompleted: { turnIndex: 2, outcome: "succeeded", durationMs: 25, hadToolCalls: true },
	messageAppended: { messageId: "message-1", cursor: 4, role: "assistant", blockKinds: ["text", "tool_use"] },
	toolCallStarted: { toolCallId: "tool-call-1", toolName: "read", turnIndex: 2 },
	toolCallCompleted: { toolCallId: "tool-call-1", toolName: "read", status: "errored", durationMs: 5, errorStatus: "denied" },
	sessionCreated: { sessionId: "session-1", kind: "general" },
	sessionArchived: { sessionId: "session-1", reason: "user" },
	sessionForked: { sourceSessionId: "session-1", sessionId: "session-2", cutEntryId: "entry-1", forkMode: "history" },
	sessionStatusChanged: { sessionId: "session-1", previousStatus: "starting", status: "idle", statusVersion: 1 },
	staffCreated: { staffId: "staff-1", state: "active", sessionId: "session-1" },
	staffConfigChanged: { staffId: "staff-1", changedFields: ["description", "name"] },
	staffRetired: { staffId: "staff-1" },
	staffSessionChanged: { staffId: "staff-1", previousSessionId: "session-1", sessionId: "session-2" },
	goalCreated: { goalId: "goal-1", state: "todo" },
	goalUpdated: { goalId: "goal-1", state: "in-progress", changedFields: ["spec", "state"] },
	goalCompleted: { goalId: "goal-1" },
	goalArchived: { goalId: "goal-1" },
	taskCreated: { taskId: "task-1", goalId: "goal-1", type: "implementation", state: "todo" },
	taskUpdated: { taskId: "task-1", goalId: "goal-1", state: "in-progress", changedFields: ["assignedSessionId", "title"] },
	taskStateChanged: { taskId: "task-1", goalId: "goal-1", previousState: "todo", state: "in-progress" },
	gateStatusChanged: { gateId: "implementation", goalId: "goal-1", previousStatus: "pending", status: "passed" },
	pullRequestStatusChanged: { goalId: "goal-1", number: 42, state: "OPEN", reviewDecision: "APPROVED", mergeability: "MERGEABLE" },
	settingsChanged: { target: "project", changedKeys: ["components", "workflows"] },
};

const interceptorRequests: Record<HostInterceptorName, unknown> = {
	sessionSetup: { sessionId: "session-1", projectId: "project-1", scope: "project", roleName: "coder", component: { name: "app" } },
	beforePrompt: { sessionId: "session-1", turnIndex: 1, source: "user", userText: "hello" },
	beforeToolCall: { toolCallId: "tool-call-1", toolName: "read", args: { path: "README.md", options: [1, true, null] } },
	afterToolResult: { toolCallId: "tool-call-1", toolName: "read", result: { ok: true } },
	beforeCompact: { sessionId: "session-1", turnIndex: 1, span: "old messages", summary: "summary" },
	sessionShutdown: { sessionId: "session-1", projectId: "project-1", reason: "terminated" },
	projectImported: { projectId: "project-1", components: [{ name: "app", repo: "." }, { name: "web", repo: "packages/web", relativePath: "src" }] },
};

const interceptorResults: Record<HostInterceptorName, unknown> = {
	sessionSetup: { context: [{ id: "context-1", title: "Memory", authority: "memory", content: "bounded", reason: "relevant", priority: 10 }] },
	beforePrompt: { context: [] },
	beforeToolCall: { action: "replaceArgs", args: { path: "safe.txt" } },
	afterToolResult: { action: "syntheticError", code: "policy_denied" },
	beforeCompact: { context: [], flush: "complete" },
	sessionShutdown: { flush: "complete" },
	projectImported: { initialised: true },
};

describe("host notification catalogue", () => {
	it("contains every canonical name once with unique scope/name identity and complete metadata", () => {
		expect(Object.keys(HOST_NOTIFICATION_CATALOGUE)).toEqual(Object.keys(payloads));
		const identities = Object.values(HOST_NOTIFICATION_CATALOGUE).map((definition) => `${definition.scope}:${definition.name}`);
		expect(new Set(identities).size).toBe(identities.length);
		for (const [key, definition] of Object.entries(HOST_NOTIFICATION_CATALOGUE)) {
			expect(definition.name).toBe(key);
			expect(definition.payloadVersion).toBe(1);
			expect(definition.boundary.length).toBeGreaterThan(10);
			expect(definition.aggregateKind.length).toBeGreaterThan(0);
			expect(definition.revisionSource.length).toBeGreaterThan(0);
			expect([...definition.consumers]).toEqual(["browser", "module", "staff", "diagnostic"]);
			expect(definition.privacy).toBe("project-metadata");
			expect(definition.delivery).toEqual({ browser: "live", module: "live", staff: "durable-intent" });
		}
	});

	it("validates every v1 payload through the catalogue TypeBox schema and helper", () => {
		for (const name of Object.keys(payloads) as HostNotificationName[]) {
			expect(Value.Check(HOST_NOTIFICATION_CATALOGUE[name].payloadSchema, payloads[name]), name).toBe(true);
			expect(validateNotificationPayload(name, payloads[name]), name).toBe(true);
		}
	});

	it("rejects unknown fields, invalid enums, non-finite values, and unsorted or duplicate change identifiers", () => {
		expect(validateNotificationPayload("goalCreated", { ...payloads.goalCreated as object, rawPrompt: "DO_NOT_LEAK" })).toBe(false);
		expect(validateNotificationPayload("turnCompleted", { turnIndex: 1, outcome: "retrying", durationMs: 1, hadToolCalls: false })).toBe(false);
		expect(validateNotificationPayload("turnCompleted", { turnIndex: 1, outcome: "errored", durationMs: Number.NaN, hadToolCalls: false })).toBe(false);
		expect(validateNotificationPayload("goalUpdated", { goalId: "goal-1", state: "todo", changedFields: ["state", "spec"] })).toBe(false);
		expect(validateNotificationPayload("goalUpdated", { goalId: "goal-1", state: "todo", changedFields: ["state", "state"] })).toBe(false);
		expect(validateNotificationPayload("settingsChanged", { target: "project", changedKeys: ["secretValue"] })).toBe(false);
		expect(validateNotificationPayload("toolCallCompleted", { toolCallId: "t", toolName: "read", status: "succeeded", durationMs: 1, errorStatus: "denied" })).toBe(false);
		expect(validateNotificationPayload("toolCallCompleted", { toolCallId: "t", toolName: "read", status: "errored", durationMs: 1 })).toBe(false);
	});

	it("enforces catalogue-owned flat staff filters and exact scope", () => {
		expect(validateNotificationFilter("session", "toolCallCompleted", { toolName: "read", status: "succeeded" })).toEqual({
			ok: true,
			filter: { toolName: "read", status: "succeeded" },
		});
		expect(validateNotificationFilter("project", "toolCallCompleted", {})).toEqual({ ok: false, code: "UNKNOWN_NOTIFICATION" });
		expect(validateNotificationFilter("project", "missing", {})).toEqual({ ok: false, code: "UNKNOWN_NOTIFICATION" });
		expect(validateNotificationFilter("project", "goalUpdated", { goalId: "goal-1" })).toEqual({ ok: false, code: "UNKNOWN_FILTER_FIELD" });
		expect(validateNotificationFilter("project", "goalUpdated", { state: "not-a-state" })).toEqual({ ok: false, code: "INVALID_FILTER_VALUE" });
		expect(validateNotificationFilter("project", "goalUpdated", { state: { nested: true } })).toEqual({ ok: false, code: "INVALID_FILTER_VALUE" });
		expect(validateNotificationFilter("session", "toolCallStarted", { toolName: "x".repeat(HOST_HOOK_LIMITS.filterBytes) })).toEqual({ ok: false, code: "FILTER_TOO_LARGE" });
	});
});

describe("canonical host notification envelope", () => {
	it("builds a strict, revisioned, deeply frozen copy", () => {
		const mutable = { goalId: "goal-1", state: "todo" };
		const event = buildHostNotification("goalCreated", {
			id: "notification-1",
			occurredAt: 100,
			projectId: "project-1",
			aggregateId: "goal-1",
			aggregateRevision: 7,
			correlationId: "correlation-1",
			payload: mutable,
		});
		mutable.state = "blocked";
		expect(event).toEqual({
			id: "notification-1",
			scope: "project",
			name: "goalCreated",
			payloadVersion: 1,
			occurredAt: 100,
			projectId: "project-1",
			aggregate: { kind: "goal", id: "goal-1", revision: 7 },
			correlationId: "correlation-1",
			payload: { goalId: "goal-1", state: "todo" },
		});
		expect(validateHostNotification(event)).toBe(true);
		expect(Value.Check(HOST_NOTIFICATION_ENVELOPE_SCHEMAS.goalCreated, event)).toBe(true);
		expect(Object.isFrozen(event)).toBe(true);
		expect(Object.isFrozen(event.aggregate)).toBe(true);
		expect(Object.isFrozen(event.payload)).toBe(true);
		expect(notificationMatchesFilter(event, { state: "todo" })).toBe(true);
		expect(notificationMatchesFilter(event, { state: "complete" })).toBe(false);
	});

	it("requires session binding only at session scope and rejects forged metadata or privacy fields", () => {
		expect(() => buildHostNotification("turnStarted", {
			id: "notification-1", occurredAt: 1, projectId: "project-1", aggregateId: "turn-1", aggregateRevision: 1,
			payload: payloads.turnStarted as never,
		})).toThrow("Invalid host notification projection");
		expect(() => buildHostNotification("goalCreated", {
			id: "notification-1", occurredAt: 1, projectId: "project-1", sessionId: "session-1", aggregateId: "goal-1", aggregateRevision: 1,
			payload: payloads.goalCreated as never,
		})).toThrow("Invalid host notification projection");

		const valid = buildHostNotification("turnStarted", {
			id: "notification-1", occurredAt: 1, projectId: "project-1", sessionId: "session-1", aggregateId: "turn-1", aggregateRevision: 1,
			payload: payloads.turnStarted as never,
		});
		for (const forbidden of [
			{ ...valid, payloadVersion: 2 },
			{ ...valid, scope: "project" },
			{ ...valid, aggregate: { ...valid.aggregate, kind: "goal" } },
			{ ...valid, rawPrompt: "DO_NOT_LEAK" },
			{ ...valid, payload: { ...valid.payload, toolResultBody: "DO_NOT_LEAK" } },
			{ ...valid, aggregate: { ...valid.aggregate, revision: Number.POSITIVE_INFINITY } },
		]) expect(validateHostNotification(forbidden), JSON.stringify(forbidden)).toBe(false);
	});
});

describe("host interceptor catalogue", () => {
	it("contains all seven contracts with the specified timing and failure metadata", () => {
		expect(Object.keys(HOST_INTERCEPTOR_CATALOGUE)).toEqual([
			"sessionSetup", "beforePrompt", "beforeToolCall", "afterToolResult", "beforeCompact", "sessionShutdown", "projectImported",
		]);
		expect(Object.fromEntries(Object.entries(HOST_INTERCEPTOR_CATALOGUE).map(([name, definition]) => [name, [definition.defaultTimeoutMs, definition.maxTimeoutMs, definition.dispatchDeadlineMs]]))).toEqual({
			sessionSetup: [1500, 3000, 5000],
			beforePrompt: [500, 1000, 1500],
			beforeToolCall: [750, 1500, 2000],
			afterToolResult: [750, 1500, 2000],
			beforeCompact: [1500, 3000, 5000],
			sessionShutdown: [1000, 2000, 3000],
			projectImported: [2000, 5000, 8000],
		});
		expect(HOST_INTERCEPTOR_CATALOGUE.beforePrompt.defaultFailurePolicy).toBe("failOpen");
		expect(HOST_INTERCEPTOR_CATALOGUE.beforeToolCall.allowedFailurePolicies.has("failClosed")).toBe(true);
		expect(HOST_INTERCEPTOR_CATALOGUE.afterToolResult.defaultFailurePolicy).toBe("failClosed");
		expect(HOST_INTERCEPTOR_CATALOGUE.projectImported.defaultFailurePolicy).toBe("nonFatal");
		for (const definition of Object.values(HOST_INTERCEPTOR_CATALOGUE)) {
			expect(definition.maxTimeoutMs).toBeLessThanOrEqual(definition.dispatchDeadlineMs);
			expect(definition.cancellation).toEqual(expect.objectContaining({ abortWorker: true, discardLateResult: true }));
			expect(definition.requiredCapabilities).toEqual([]);
		}
	});

	it("validates every request/result and rejects unknown fields and malformed decisions", () => {
		for (const name of Object.keys(HOST_INTERCEPTOR_CATALOGUE) as HostInterceptorName[]) {
			expect(Value.Check(HOST_INTERCEPTOR_CATALOGUE[name].requestSchema, interceptorRequests[name]), `${name} request schema`).toBe(true);
			expect(validateInterceptorRequest(name, interceptorRequests[name]), `${name} request`).toBe(true);
			expect(Value.Check(HOST_INTERCEPTOR_CATALOGUE[name].resultSchema, interceptorResults[name]), `${name} result schema`).toBe(true);
			expect(validateInterceptorResult(name, interceptorResults[name]), `${name} result`).toBe(true);
		}
		expect(validateInterceptorRequest("beforeToolCall", { ...interceptorRequests.beforeToolCall as object, cwd: "/secret" })).toBe(false);
		expect(validateInterceptorResult("beforeToolCall", { action: "block", reason: "raw provider error" })).toBe(false);
		expect(validateInterceptorResult("afterToolResult", { action: "syntheticError", code: "raw_stack_trace" })).toBe(false);
		expect(validateInterceptorRequest("projectImported", { projectId: "p", components: [{ name: "app", repo: "/absolute" }] })).toBe(false);
		expect(validateInterceptorRequest("projectImported", { projectId: "p", components: [{ name: "app", repo: "../outside" }] })).toBe(false);
	});

	it("bounds structured inputs and emits body-free audit projections", () => {
		let nested: unknown = "leaf";
		for (let index = 0; index < HOST_HOOK_LIMITS.jsonDepth + 2; index += 1) nested = { child: nested };
		expect(validateInterceptorRequest("beforeToolCall", { toolCallId: "t", toolName: "read", args: { nested } })).toBe(false);
		expect(validateInterceptorRequest("beforeToolCall", { toolCallId: "t", toolName: "read", args: { n: Number.NaN } })).toBe(false);
		expect(validateInterceptorRequest("beforePrompt", { sessionId: "s", turnIndex: 1, source: "user", userText: "x".repeat(HOST_HOOK_LIMITS.textLength + 1) })).toBe(false);

		const audit = HOST_INTERCEPTOR_CATALOGUE.afterToolResult.auditProjector(
			{ toolCallId: "t", toolName: "read", result: { secret: "DO_NOT_LEAK" } },
			{ action: "replaceResult", result: { secret: "DO_NOT_LEAK" } },
		);
		expect(audit).toEqual({ proposal: "received" });
		expect(JSON.stringify(audit)).not.toContain("DO_NOT_LEAK");
	});
});
