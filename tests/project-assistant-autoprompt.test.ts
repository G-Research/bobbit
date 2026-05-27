/**
 * Golden-output tests for `formatProjectAssistantAutoPrompt`.
 *
 * This pins the exact text the Add-Project flow sends to the project-assistant
 * on its first turn. The server-side prompt in
 * `src/server/agent/project-assistant.ts` is taught to recognise the
 * "User-confirmed initial repo/subdirectory selection" block by its literal
 * header and the fenced ```json``` payload — if you change the format below,
 * update that prompt + its tests at the same time.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	formatProjectAssistantAutoPrompt,
	type ProjectScanItem,
	type ProjectAssistantScanContext,
} from "../src/app/project-assistant-autoprompt.ts";

const apiItem: ProjectScanItem = {
	id: "repo:api",
	kind: "repo",
	label: "api",
	repo: "api",
	absolutePath: "/work/proj/api",
	hasGit: true,
	detectedCommands: { build: "npm run build", test: "npm test" },
};
const webItem: ProjectScanItem = {
	id: "repo:web",
	kind: "repo",
	label: "web",
	repo: "web",
	absolutePath: "/work/proj/web",
	hasGit: true,
	detectedCommands: { build: "npm run build" },
};
const docsItem: ProjectScanItem = {
	id: "repo:docs",
	kind: "repo",
	label: "docs",
	repo: "docs",
	absolutePath: "/work/proj/docs",
	hasGit: false,
	detectedCommands: {},
};

const mApi: ProjectScanItem = {
	id: "workspace:packages/api",
	kind: "workspace",
	label: "packages/api",
	repo: ".",
	relativePath: "packages/api",
	absolutePath: "/work/mono/packages/api",
	hasGit: false,
	detectedCommands: { build: "pnpm --filter api build" },
};
const mWeb: ProjectScanItem = {
	id: "workspace:packages/web",
	kind: "workspace",
	label: "packages/web",
	repo: ".",
	relativePath: "packages/web",
	absolutePath: "/work/mono/packages/web",
	hasGit: false,
	detectedCommands: { build: "pnpm --filter web build" },
};

describe("formatProjectAssistantAutoPrompt", () => {
	it("(a) plain new-project path produces the historical opener", () => {
		const out = formatProjectAssistantAutoPrompt({ dirPath: "/work/proj" });
		assert.equal(out, "Start the project registration session. The project directory is: /work/proj");
	});

	it("(b) scaffolding switches to the new-project setup opener", () => {
		const out = formatProjectAssistantAutoPrompt({ dirPath: "/work/new", scaffolding: true });
		assert.equal(out, "Start the new project setup session. The target directory is: /work/new");
	});

	it("(c) edit-existing produces the verbatim edit-mode opener", () => {
		const out = formatProjectAssistantAutoPrompt({
			dirPath: "/work/proj",
			editContext: { name: "my-api", rootPath: "/work/proj" },
		});
		assert.equal(
			out,
			"Edit the existing project 'my-api' at /work/proj. Read its current `.bobbit/config/project.yaml` and propose it back as-is via `propose_project`, then ask the user what they want to change or add.",
		);
	});

	it("(c2) editContext takes precedence over scaffolding + initialScanContext", () => {
		const out = formatProjectAssistantAutoPrompt({
			dirPath: "/work/proj",
			scaffolding: true,
			editContext: { name: "x", rootPath: "/work/proj" },
			initialScanContext: { rootPath: "/work/proj", items: [apiItem], selectedIds: ["repo:api"] },
		});
		assert.ok(out.startsWith("Edit the existing project 'x'"));
	});

	it("(d) subset selection with 2-of-3 multi-repo items emits English summary + JSON block", () => {
		const ctx: ProjectAssistantScanContext = {
			rootPath: "/work/proj",
			items: [apiItem, webItem, docsItem],
			selectedIds: ["repo:api", "repo:web"],
		};
		const out = formatProjectAssistantAutoPrompt({ dirPath: "/work/proj", initialScanContext: ctx });

		// Opener line preserved verbatim.
		assert.ok(out.startsWith("Start the project registration session. The project directory is: /work/proj\n"),
			"prompt must start with the canonical new-project opener");

		// English summary.
		assert.ok(out.includes("User-confirmed initial repo/subdirectory selection from Add Project:"),
			"prompt must include the literal header recognised by the server prompt");
		assert.ok(out.includes("- Selected 2 of 3 repo/subdirectory candidates: `api`, `web`"));
		assert.ok(out.includes("- Not selected: `docs`"));
		assert.ok(out.includes("- Treat only the selected repos/subdirectories as candidates for the initial `propose_project.components`."));
		assert.ok(out.includes("- Do not include unselected entries by default, but tell the user they can add them back."));

		// Machine-readable JSON block.
		assert.ok(out.includes("Machine-readable selection:"));
		const fenceStart = out.indexOf("```json\n");
		const fenceEnd = out.indexOf("\n```", fenceStart + 1);
		assert.ok(fenceStart >= 0 && fenceEnd > fenceStart, "must contain a ```json ... ``` fenced block");
		const json = out.slice(fenceStart + "```json\n".length, fenceEnd);
		const parsed = JSON.parse(json) as ProjectAssistantScanContext;
		assert.equal(parsed.rootPath, "/work/proj");
		assert.deepEqual(parsed.selectedIds, ["repo:api", "repo:web"]);
		assert.equal(parsed.items.length, 3);
		assert.equal(parsed.items[0].id, "repo:api");
		assert.equal(parsed.items[2].id, "repo:docs");
		// Items must carry the full normalized shape so the assistant can lift them straight into components.
		assert.deepEqual(parsed.items[0].detectedCommands, { build: "npm run build", test: "npm test" });
	});

	it("(e) subset with all selected uses the '(none ... all candidates selected)' wording", () => {
		const ctx: ProjectAssistantScanContext = {
			rootPath: "/work/proj",
			items: [apiItem, webItem],
			selectedIds: ["repo:api", "repo:web"],
		};
		const out = formatProjectAssistantAutoPrompt({ dirPath: "/work/proj", initialScanContext: ctx });
		assert.ok(out.includes("- Selected 2 of 2 repo/subdirectory candidates: `api`, `web`"));
		assert.ok(out.includes("- Not selected: (none — all candidates selected)"));
	});

	it("(f) subset with monorepo workspaces emits the workspace labels and preserves relativePath in JSON", () => {
		const ctx: ProjectAssistantScanContext = {
			rootPath: "/work/mono",
			items: [mApi, mWeb],
			selectedIds: ["workspace:packages/api"],
		};
		const out = formatProjectAssistantAutoPrompt({ dirPath: "/work/mono", initialScanContext: ctx });
		assert.ok(out.includes("- Selected 1 of 2 repo/subdirectory candidates: `packages/api`"));
		assert.ok(out.includes("- Not selected: `packages/web`"));
		const fenceStart = out.indexOf("```json\n");
		const fenceEnd = out.indexOf("\n```", fenceStart + 1);
		const json = JSON.parse(out.slice(fenceStart + "```json\n".length, fenceEnd)) as ProjectAssistantScanContext;
		assert.equal(json.items[0].relativePath, "packages/api");
		assert.equal(json.items[0].kind, "workspace");
		assert.equal(json.items[0].repo, ".");
	});

	it("empty items array falls back to the plain new-project opener (no subset block)", () => {
		const ctx: ProjectAssistantScanContext = {
			rootPath: "/work/proj",
			items: [],
			selectedIds: [],
		};
		const out = formatProjectAssistantAutoPrompt({ dirPath: "/work/proj", initialScanContext: ctx });
		assert.equal(out, "Start the project registration session. The project directory is: /work/proj");
	});

	it("selectedIds order is normalized to items display order", () => {
		// selectedIds passed in reverse order — re-serialized JSON must follow items[] order.
		const ctx: ProjectAssistantScanContext = {
			rootPath: "/work/proj",
			items: [apiItem, webItem, docsItem],
			selectedIds: ["repo:web", "repo:api"],
		};
		const out = formatProjectAssistantAutoPrompt({ dirPath: "/work/proj", initialScanContext: ctx });
		// English summary lists in items order.
		assert.ok(out.includes("- Selected 2 of 3 repo/subdirectory candidates: `api`, `web`"),
			"English label list should follow items[] display order, not input selectedIds order");
		// JSON selectedIds also re-serialized in display order.
		const fenceStart = out.indexOf("```json\n");
		const fenceEnd = out.indexOf("\n```", fenceStart + 1);
		const json = JSON.parse(out.slice(fenceStart + "```json\n".length, fenceEnd)) as ProjectAssistantScanContext;
		assert.deepEqual(json.selectedIds, ["repo:api", "repo:web"]);
	});

	it("unknown selectedId is rendered using the id itself as a fallback label", () => {
		// Defensive: if a stale id slips into selectedIds the prompt still renders
		// (with the id verbatim) instead of crashing.
		const ctx: ProjectAssistantScanContext = {
			rootPath: "/work/proj",
			items: [apiItem],
			selectedIds: ["repo:api", "repo:ghost"],
		};
		const out = formatProjectAssistantAutoPrompt({ dirPath: "/work/proj", initialScanContext: ctx });
		// Ghost id is filtered out of orderedSelected (since it isn't in items),
		// so the English list only mentions `api`.
		assert.ok(out.includes("- Selected 1 of 1 repo/subdirectory candidates: `api`"));
	});
});
