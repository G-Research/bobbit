import { expect, test } from "./_e2e/in-process-harness.js";

test.describe("POST /api/sessions/:id/provider-hooks/before-compact", () => {
	test("forwards a string span to the lifecycle hook and rejects non-string spans", async ({ gateway, scope }) => {
		const sessionId = `before-compact-api-${process.pid}-${Date.now()}`;
		const context = gateway.projectContextManager.getOrCreate(gateway.defaultProjectId);
		expect(context).toBeTruthy();
		context.sessionStore.put({
			id: sessionId,
			title: "Before compact API fixture",
			cwd: gateway.bobbitDir,
			agentSessionFile: `${gateway.bobbitDir}/${sessionId}.jsonl`,
			createdAt: Date.now(),
			lastActivity: Date.now(),
			archived: false,
			projectId: gateway.defaultProjectId,
		});
		scope.trackSession(sessionId);

		const originalHub = gateway.sessionManager.lifecycleHub;
		const dispatches: Array<{ hook: string; hookContext: Record<string, unknown> }> = [];
		gateway.sessionManager.lifecycleHub = {
			async dispatch(hook: string, hookContext: Record<string, unknown>) {
				dispatches.push({ hook, hookContext });
				return { blocks: [], diagnostics: [] };
			},
		};

		try {
			const valid = await gateway.api(`/api/sessions/${sessionId}/provider-hooks/before-compact`, {
				method: "POST",
				body: JSON.stringify({ span: "conversation span to retain" }),
			});
			expect(valid.status).toBe(200);
			expect(await valid.json()).toEqual({});
			expect(dispatches).toHaveLength(1);
			expect(dispatches[0]).toMatchObject({
				hook: "beforeCompact",
				hookContext: {
					sessionId,
					projectId: gateway.defaultProjectId,
					span: "conversation span to retain",
				},
			});

			const invalid = await gateway.api(`/api/sessions/${sessionId}/provider-hooks/before-compact`, {
				method: "POST",
				body: JSON.stringify({ span: 42 }),
			});
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toEqual({ error: "span must be a string" });
			expect(dispatches).toHaveLength(1);
		} finally {
			gateway.sessionManager.lifecycleHub = originalHub;
		}
	});
});
