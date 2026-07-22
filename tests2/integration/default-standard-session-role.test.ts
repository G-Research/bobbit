import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, defaultProject, nonGitCwd } from "./_e2e/e2e-setup.js";

const REPRO = "DEFAULT_STANDARD_ROLE_MISMATCH";
const GENERAL_ROLE = "general";

let project: { id: string; rootPath: string };

async function readJson(response: Response): Promise<any> {
	const text = await response.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return { raw: text };
	}
}

test.beforeAll(async () => {
	project = await defaultProject();
});

test("POST without roleId persists general across POST, live state, persistence, detail, and list", async ({ gateway }) => {
	let sessionId: string | undefined;
	try {
		const createResponse = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd(), projectId: project.id, worktree: false }),
		});
		const created = await readJson(createResponse);
		expect(createResponse.status, `POST /api/sessions failed; body=${JSON.stringify(created)}`).toBe(201);
		expect(created.id, "POST /api/sessions must return a session id").toBeTruthy();
		sessionId = created.id;

		const detailResponse = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId!)}`);
		const detail = await readJson(detailResponse);
		expect(detailResponse.status, `GET session failed; body=${JSON.stringify(detail)}`).toBe(200);

		const listResponse = await apiFetch(`/api/sessions?projectId=${encodeURIComponent(project.id)}`);
		const listBody = await readJson(listResponse);
		expect(listResponse.status, `GET session list failed; body=${JSON.stringify(listBody)}`).toBe(200);
		const listed = (listBody.sessions ?? listBody).find((session: any) => session.id === sessionId);
		expect(listed, `GET /api/sessions must include ${sessionId}`).toBeTruthy();

		const observed = {
			post: created.role ?? null,
			live: gateway.sessionManager.getSession(sessionId!)?.role ?? null,
			persisted: gateway.sessionManager.getPersistedSession(sessionId!)?.role ?? null,
			detail: detail.role ?? null,
			list: listed.role ?? null,
		};
		expect(
			observed,
			`${REPRO}: omitted roleId must resolve to role=general across every creation surface; observed=${JSON.stringify(observed)}`,
		).toEqual({
			post: GENERAL_ROLE,
			live: GENERAL_ROLE,
			persisted: GENERAL_ROLE,
			detail: GENERAL_ROLE,
			list: GENERAL_ROLE,
		});
	} finally {
		if (sessionId) {
			await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}?purge=true`, { method: "DELETE" }).catch(() => undefined);
		}
	}
});
