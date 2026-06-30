/**
 * Regression coverage for delegate prompt-section snapshots.
 *
 * A team_delegate child receives durable instructions in its assembled prompt.
 * The provider before-prompt hook refreshes the persisted prompt-sections JSON;
 * that refresh must not reconstruct the prompt without the delegate task.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./e2e-setup.js";

const PROMPT_REFRESH_ASSERTION = "Expected refreshed delegate prompt sections to retain durable delegate instructions";

test.setTimeout(45_000);

async function spawnDelegate(parentId: string, instructions: string, readOnly: boolean): Promise<string> {
	const resp = await apiFetch(`/api/sessions/${parentId}/orchestrate/spawn`, {
		method: "POST",
		body: JSON.stringify({ instructions, read_only: readOnly }),
	});
	expect(resp.status).toBe(201);
	const body = await resp.json();
	expect(typeof body.childSessionId).toBe("string");
	return body.childSessionId;
}

async function promptSectionsText(sessionId: string): Promise<string> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/prompt-sections`);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	expect(Array.isArray(body.sections)).toBe(true);
	return body.sections
		.map((section: any) => `${section.label ?? ""}\n${section.source ?? ""}\n${section.content ?? ""}`)
		.join("\n\n---\n\n");
}

async function refreshPromptSections(sessionId: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/provider-hooks/before-prompt`, {
		method: "POST",
		body: JSON.stringify({ prompt: "refresh prompt-section snapshot" }),
	});
	expect(resp.status).toBe(200);
}

for (const { name, readOnly } of [
	{ name: "normal delegate", readOnly: false },
	{ name: "read-only delegate", readOnly: true },
]) {
	test(`${name} keeps durable instructions in prompt sections after before-prompt refresh`, async () => {
		const parentId = await createSession();
		const marker = `delegate-prompt-viewer-${readOnly ? "readonly" : "normal"}-${Date.now()}`;
		const instructions = `Preserve this durable delegate task marker in prompt sections: ${marker}`;
		let delegateId: string | undefined;

		try {
			delegateId = await spawnDelegate(parentId, instructions, readOnly);

			const beforeRefresh = await promptSectionsText(delegateId);
			expect(
				beforeRefresh,
				"Delegate prompt sections should initially expose the durable instructions before the provider hook refresh",
			).toContain(marker);

			await refreshPromptSections(delegateId);

			const afterRefresh = await promptSectionsText(delegateId);
			expect(afterRefresh, PROMPT_REFRESH_ASSERTION).toContain(marker);
		} finally {
			if (delegateId) await deleteSession(delegateId).catch(() => {});
			await deleteSession(parentId).catch(() => {});
		}
	});
}
