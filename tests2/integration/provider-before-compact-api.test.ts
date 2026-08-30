import { expect, test } from "./_e2e/in-process-harness.js";

test.describe("POST /api/sessions/:id/provider-hooks/before-compact", () => {
	test("forwards a string span to the lifecycle hook and rejects non-string spans", async ({ gateway, scope }) => {
		const session = await scope.createSession({
			title: "Before compact API fixture",
			cwd: gateway.projectContextManager.getRegistry().get(gateway.defaultProjectId).rootPath,
			projectId: gateway.defaultProjectId,
		});
		const sessionId = session.id;

		const originalHostInterceptors = gateway.sessionManager.hostInterceptors;
		const dispatches: Array<{ hook: string; hookContext: Record<string, unknown> }> = [];
		gateway.sessionManager.setHostInterceptorPort({
			async dispatch(hook: string, input: Record<string, unknown>, requestContext: Record<string, unknown>) {
				dispatches.push({ hook, hookContext: { ...input, projectId: requestContext.projectId } });
				return input;
			},
		});

		try {
			const sessionSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(sessionId);
			const foreignSecret = gateway.sessionManager.sessionSecretStore.getOrCreateSecret(`${sessionId}-foreign`);

			for (const headers of [
				undefined,
				{ "X-Bobbit-Session-Secret": foreignSecret },
			]) {
				const unauthorized = await gateway.api(`/api/sessions/${sessionId}/provider-hooks/before-compact`, {
					method: "POST",
					headers,
					body: JSON.stringify({ span: "conversation span to retain" }),
				});
				expect(unauthorized.status).toBe(403);
			}
			expect(dispatches).toHaveLength(0);

			const valid = await gateway.api(`/api/sessions/${sessionId}/provider-hooks/before-compact`, {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": sessionSecret },
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
				headers: { "X-Bobbit-Session-Secret": sessionSecret },
				body: JSON.stringify({ span: 42 }),
			});
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toEqual({ error: "Invalid bounded beforeCompact body" });
			expect(dispatches).toHaveLength(1);
		} finally {
			gateway.sessionManager.setHostInterceptorPort(originalHostInterceptors);
		}
	});
});
