import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect } from "../../../tests2/integration/_e2e/in-process-harness.js";

function notification(projectId: string, sessionId: string, id: string) {
	return {
		id: `notification-${id}`,
		scope: "project",
		name: "taskUpdated",
		payloadVersion: 1,
		occurredAt: 1_700_000_000_000,
		projectId,
		sessionId,
		aggregate: { kind: "task", id: `task-${id}`, revision: 7 },
		correlationId: "canonical-correlation",
		causationId: "canonical-causation",
		payload: { taskId: `task-${id}`, title: "bounded title", state: "in-progress" },
	};
}

test.describe("notification staff inbox authority", () => {
	test("binds canonical metadata and mutations to the exact owning staff-session secret", async ({ gateway, scope }) => {
		const projectBRoot = join(dirname(gateway.bobbitDir), `notification-inbox-project-${randomUUID()}`);
		mkdirSync(projectBRoot, { recursive: true });
		const projectB = await gateway.apiJson<any>("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: `notification-inbox-${randomUUID()}`, rootPath: projectBRoot, __e2e_seed_skip__: true }),
		});
		scope.trackProject(projectB.id);

		const createStaff = async (projectId: string, cwd: string, name: string) => {
			const response = await gateway.api("/api/staff", {
				method: "POST",
				body: JSON.stringify({ name, systemPrompt: "Inbox authority fixture.", cwd, projectId, worktree: false }),
			});
			expect(response.status, await response.clone().text()).toBe(201);
			return response.json();
		};

		const defaultRoot = gateway.projectContextManager.getRegistry().get(gateway.defaultProjectId).rootPath;
		const staffA = await createStaff(gateway.defaultProjectId, defaultRoot, `foreign-staff-${randomUUID()}`);
		const staffB = await createStaff(projectB.id, projectBRoot, `owning-staff-${randomUUID()}`);
		try {
			expect(staffA.currentSessionId).toBeTruthy();
			expect(staffB.currentSessionId).toBeTruthy();
			const projectBContext = gateway.projectContextManager.all().find((ctx: any) => ctx.staffStore.get(staffB.id));
			expect(projectBContext).toBeTruthy();

			const canonical = notification(projectB.id, staffB.currentSessionId, "complete");
			for (const [entryId, event] of [
				["notification-entry-complete", canonical],
				["notification-entry-dismiss", notification(projectB.id, staffB.currentSessionId, "dismiss")],
				["notification-entry-delete", notification(projectB.id, staffB.currentSessionId, "delete")],
			] as const) {
				projectBContext.inboxStore.put({
					id: entryId,
					staffId: staffB.id,
					source: { type: "notification", triggerId: "fixture-trigger" },
					title: "Canonical notification",
					prompt: "A host notification is available in this inbox entry's notification metadata.",
					notificationInput: {
						notification: event,
						rootCorrelationId: "host-owned-root",
						causationDepth: 2,
					},
					state: "pending",
					createdAt: Date.now(),
				});
			}

			const foreignSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(staffA.currentSessionId);
			const ownerSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(staffB.currentSessionId);
			const unboundSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(`unbound-${randomUUID()}`);
			const ownerHeaders = { "X-Bobbit-Session-Secret": ownerSecret };

			// Browser/operator and cross-project callers keep the legacy list surface,
			// but receive only the bounded DTO used by live UI publication.
			for (const headers of [undefined, { "X-Bobbit-Session-Secret": foreignSecret }, { "X-Bobbit-Session-Secret": unboundSecret }]) {
				const listed = await gateway.api(`/api/staff/${staffB.id}/inbox?state=pending`, { headers });
				expect(listed.status).toBe(200);
				const body = await listed.json();
				expect(body.entries).toHaveLength(3);
				expect(JSON.stringify(body)).not.toContain("notificationInput");
				expect(JSON.stringify(body)).not.toContain("rootCorrelationId");
				expect(JSON.stringify(body)).not.toContain("causationDepth");
			}

			const ownerList = await gateway.api(`/api/staff/${staffB.id}/inbox?state=pending`, { headers: ownerHeaders });
			expect(ownerList.status).toBe(200);
			const ownerBody = await ownerList.json();
			const completeEntry = ownerBody.entries.find((entry: any) => entry.id === "notification-entry-complete");
			expect(completeEntry.notificationInput).toEqual({
				notification: canonical,
				rootCorrelationId: "host-owned-root",
				causationDepth: 2,
			});

			// A project-A capability cannot borrow project B's public staff/session ids.
			const foreignComplete = await gateway.api(`/api/staff/${staffB.id}/inbox/notification-entry-complete/complete`, {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": foreignSecret },
				body: JSON.stringify({ sessionId: staffB.currentSessionId, summary: "forged" }),
			});
			expect(foreignComplete.status).toBe(403);

			// Unbound and browser/viewer bearer callers cannot suppress delivery either.
			const unboundDismiss = await gateway.api(`/api/staff/${staffB.id}/inbox/notification-entry-dismiss/dismiss`, {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": unboundSecret },
				body: JSON.stringify({ sessionId: staffB.currentSessionId, outcome: "cancelled", reason: "forged" }),
			});
			expect(unboundDismiss.status).toBe(403);
			const viewerDelete = await gateway.api(`/api/staff/${staffB.id}/inbox/notification-entry-delete`, { method: "DELETE" });
			expect(viewerDelete.status).toBe(403);
			for (const id of ["notification-entry-complete", "notification-entry-dismiss", "notification-entry-delete"]) {
				expect(projectBContext.inboxStore.get(staffB.id, id)?.state).toBe("pending");
			}

			// The capability is the authority: caller-supplied session ids are ignored,
			// while the exact owner retains the original canonical input.
			const completed = await gateway.api(`/api/staff/${staffB.id}/inbox/notification-entry-complete/complete`, {
				method: "POST",
				headers: ownerHeaders,
				body: JSON.stringify({ sessionId: staffA.currentSessionId, summary: "accepted by owner" }),
			});
			expect(completed.status, await completed.clone().text()).toBe(200);
			const completedBody = await completed.json();
			expect(completedBody.entry.notificationInput.notification).toEqual(canonical);
			expect(completedBody.entry.state).toBe("completed");

			const dismissed = await gateway.api(`/api/staff/${staffB.id}/inbox/notification-entry-dismiss/dismiss`, {
				method: "POST",
				headers: ownerHeaders,
				body: JSON.stringify({ outcome: "cancelled", reason: "owner decision" }),
			});
			expect(dismissed.status, await dismissed.clone().text()).toBe(200);
			expect((await dismissed.json()).entry.state).toBe("cancelled");

			const deleted = await gateway.api(`/api/staff/${staffB.id}/inbox/notification-entry-delete`, {
				method: "DELETE",
				headers: ownerHeaders,
			});
			expect(deleted.status, await deleted.clone().text()).toBe(200);
			expect(projectBContext.inboxStore.get(staffB.id, "notification-entry-delete")).toBeUndefined();
		} finally {
			await gateway.api(`/api/staff/${staffA.id}`, { method: "DELETE" }).catch(() => undefined);
			await gateway.api(`/api/staff/${staffB.id}`, { method: "DELETE" }).catch(() => undefined);
		}
	});
});
