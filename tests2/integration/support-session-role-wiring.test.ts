/**
 * REPRODUCING integration test for the Support Assistant fix-up (defects 5 & 6).
 *
 * This asserts the FIXED behaviour, so it FAILS on the current (unfixed) code:
 *
 *   Defect 6 — a running Support session must carry the support role identity
 *   (`role: "support"`, `accessory: "headset"`), matching the Role Manager and
 *   defaults/roles/support.yaml. Current code hardcodes `role: "assistant"`,
 *   `accessory: "wand"` for every assistant session (server.ts ~line 6524).
 *
 *   Defect 5 — an assistant session's system prompt must expose a dedicated
 *   `Role`-typed section (`source: "Role: support"`) carrying the support
 *   role's promptTemplate, WITHOUT folding that template into the `Goal`
 *   section. Current code prepends the role template into the goal spec and
 *   passes no rolePrompt/roleName to assemblePrompt (session-setup.ts
 *   resolvePrompt assistant branch), so there is no `Role` section and the
 *   role text is duplicated into `Goal`.
 *
 * Support targets Headquarters (mirrors the client launcher in
 * src/app/dialogs.ts::showSupportDialog which POSTs
 * `{ assistantType: "support", projectId: HEADQUARTERS_PROJECT_ID }`).
 *
 * External-free, retries:0 — waits on observable state (polls GET) instead of
 * fixed sleeps.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import { rawApiFetch, deleteSession } from "./_e2e/e2e-setup.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";

// Distinctive substring from defaults/roles/support.yaml `promptTemplate` — NOT
// present in SUPPORT_ASSISTANT_PROMPT (which uses "## Grounding your answers").
// After the fix this must live ONLY in the dedicated Role section.
const ROLE_TEMPLATE_PHRASE = "Read all of Bobbit's documentation and source freely";
// Distinctive phrase from SUPPORT_ASSISTANT_PROMPT (the Goal-section content).
const GOAL_PROMPT_PHRASE = "Bobbit Support Assistant";

interface PromptSection { label: string; source: string; content: string; tokens: number }

async function createSupportSession(): Promise<string> {
	const resp = await rawApiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ assistantType: "support", projectId: HEADQUARTERS_PROJECT_ID }),
	});
	const text = await resp.text();
	expect(resp.status, `create support session; got ${resp.status} body=${text}`).toBe(201);
	const data = JSON.parse(text);
	expect(data.id).toBeTruthy();
	expect(data.assistantType).toBe("support");
	return data.id as string;
}

async function getSession(id: string): Promise<any> {
	const resp = await rawApiFetch(`/api/sessions/${id}`);
	expect(resp.status, `GET session ${id}`).toBe(200);
	return resp.json();
}

async function getPromptSections(id: string): Promise<PromptSection[]> {
	// Poll until the persisted prompt-sections snapshot is available.
	const start = Date.now();
	let lastErr: unknown;
	while (Date.now() - start < 10_000) {
		try {
			const resp = await rawApiFetch(`/api/sessions/${id}/prompt-sections`);
			expect(resp.status).toBe(200);
			const body = await resp.json();
			expect(Array.isArray(body?.sections)).toBe(true);
			expect(body.sections.length).toBeGreaterThan(0);
			return body.sections as PromptSection[];
		} catch (err) {
			lastErr = err;
			await new Promise(r => setTimeout(r, 100));
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error("prompt-sections not available within 10000ms");
}

test.describe("Support session role wiring (reproducing defects 5 & 6)", () => {
	test("Defect 6 — support session persists role=support, accessory=headset", async () => {
		const id = await createSupportSession();
		try {
			const session = await getSession(id);
			expect(session.role, `support session role should be "support", got "${session.role}"`).toBe("support");
			expect(session.accessory, `support session accessory should be "headset", got "${session.accessory}"`).toBe("headset");
		} finally {
			await deleteSession(id);
		}
	});

	test("Defect 5 — assembled prompt exposes a dedicated Role section, not folded into Goal", async () => {
		const id = await createSupportSession();
		try {
			const sections = await getPromptSections(id);

			// A dedicated Role-typed section carrying the support role's promptTemplate.
			const roleSection = sections.find(s => s.label === "Role");
			expect(roleSection, `expected a section with label "Role"; labels were: ${sections.map(s => s.label).join(", ")}`).toBeTruthy();
			expect(roleSection!.source).toBe("Role: support");
			expect(
				roleSection!.content.includes(ROLE_TEMPLATE_PHRASE),
				`Role section should carry the support role promptTemplate (missing "${ROLE_TEMPLATE_PHRASE}")`,
			).toBe(true);

			// The Goal section must carry the assistant prompt, NOT the role template.
			const goalSection = sections.find(s => s.label === "Goal");
			expect(goalSection, `expected a section with label "Goal"`).toBeTruthy();
			expect(
				goalSection!.content.includes(GOAL_PROMPT_PHRASE),
				`Goal section should carry SUPPORT_ASSISTANT_PROMPT (missing "${GOAL_PROMPT_PHRASE}")`,
			).toBe(true);
			expect(
				goalSection!.content.includes(ROLE_TEMPLATE_PHRASE),
				`Goal section must NOT fold in the role template (found "${ROLE_TEMPLATE_PHRASE}")`,
			).toBe(false);

			// No duplication: the role template phrase appears in exactly one section.
			const withRolePhrase = sections.filter(s => s.content.includes(ROLE_TEMPLATE_PHRASE));
			expect(
				withRolePhrase.map(s => s.label),
				`role template phrase should appear in exactly one section (the Role section)`,
			).toEqual(["Role"]);
		} finally {
			await deleteSession(id);
		}
	});
});
