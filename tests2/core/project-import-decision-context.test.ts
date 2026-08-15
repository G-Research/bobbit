import { describe, expect, it } from "vitest";
import path from "node:path";
import {
	DETECTED_PROJECT_LANGUAGES,
	MAX_PROJECT_IMPORT_COMPONENTS,
	MAX_PROJECT_IMPORT_ROOT_ENTRIES,
	ProjectImportDecisionContextError,
	buildProjectImportDecisionContext,
	validateProjectImportDecisionContext,
} from "../../src/server/agent/project-import-decision-context.ts";

type FakeFs = Parameters<typeof buildProjectImportDecisionContext>[0]["fs"];

function fakeFs(paths: Record<string, string>, entries: Record<string, string[]> = {}, observed: string[] = []): NonNullable<FakeFs> {
	return {
		realpathSync(candidate) {
			const key = path.resolve(String(candidate));
			const resolved = paths[key];
			if (!resolved) throw new Error("ENOENT");
			return resolved;
		},
		existsSync(candidate) { return Object.hasOwn(entries, String(candidate)); },
		readdirSync(candidate) {
			observed.push(String(candidate));
			return entries[String(candidate)] ?? [];
		},
	} as NonNullable<FakeFs>;
}

const project = { id: "project-1", rootPath: "/links/project" };

describe("project import decision context", () => {
	it("canonicalizes the project, rejects symlink escapes, and exposes only owned roots", () => {
		const fs = fakeFs({
			"/links/project": "/workspace/project",
			"/workspace/project/apps/owned": "/workspace/project/apps/owned",
			"/workspace/project/apps/escape": "/outside/secret",
		}, { "/workspace/project/apps/owned": ["index.ts"] });
		const context = buildProjectImportDecisionContext({
			project,
			importId: "import-1",
			components: [
				{ name: "owned", repo: "apps/owned" },
				{ name: "escaped", repo: "apps/escape" },
			],
			fs,
		});
		expect(context).toMatchObject({
			event: "projectImported",
			projectRoot: "/workspace/project",
			ownedRoots: ["/workspace/project", "/workspace/project/apps/owned"],
			components: [{ root: "/workspace/project/apps/owned", languages: ["typescript"] }],
		});
		expect(context.components[0]!.id).toMatch(/^component-0-[a-z2-7]+$/);
		expect(Object.isFrozen(context)).toBe(true);
		expect(Object.isFrozen(context.components)).toBe(true);
		expect(Object.isFrozen(context.components[0]!)).toBe(true);
	});

	it("sorts stable opaque component identities and caps their public count", () => {
		const paths: Record<string, string> = { "/links/project": "/workspace/project" };
		const components = Array.from({ length: MAX_PROJECT_IMPORT_COMPONENTS + 5 }, (_, index) => {
			const repo = `packages/${String(MAX_PROJECT_IMPORT_COMPONENTS + 5 - index).padStart(2, "0")}`;
			paths[`/workspace/project/${repo}`] = `/workspace/project/${repo}`;
			return { name: `untrusted display ${index}`, repo };
		});
		const context = buildProjectImportDecisionContext({ project, importId: "import-1", components, fs: fakeFs(paths) });
		expect(context.components).toHaveLength(MAX_PROJECT_IMPORT_COMPONENTS);
		expect(context.components.map(component => component.root)).toEqual([...context.components.map(component => component.root)].sort());
		expect(context.components.map(component => component.id).join(" ")).not.toContain("untrusted display");
		const second = buildProjectImportDecisionContext({ project, importId: "import-1", components, fs: fakeFs(paths) });
		expect(second.components.map(component => component.id)).toEqual(context.components.map(component => component.id));
	});

	it("uses only direct bounded entry names and fixed sorted language identifiers", () => {
		const observed: string[] = [];
		const allExtensions = [
			"a.c", "a.cpp", "a.cs", "a.dart", "a.ex", "a.go", "a.hs", "a.java", "a.js", "a.kt",
			"a.lua", "a.php", "a.py", "a.rb", "a.rs", "a.scala", "a.sh", "a.sql", "a.swift", "a.ts",
		];
		const paths = { "/links/project": "/workspace/project", "/workspace/project/app": "/workspace/project/app" };
		const context = buildProjectImportDecisionContext({
			project,
			importId: "import-1",
			components: [{ name: "app", repo: "app" }],
			fs: fakeFs(paths, { "/workspace/project/app": allExtensions }, observed),
		});
		expect(context.components[0]!.languages).toEqual([...DETECTED_PROJECT_LANGUAGES].sort().slice(0, 12));
		expect(observed).toEqual(["/workspace/project/app"]);

		const cappedEntries = Array.from({ length: MAX_PROJECT_IMPORT_ROOT_ENTRIES }, (_, index) => `entry-${index}`);
		const capped = buildProjectImportDecisionContext({
			project,
			importId: "import-1",
			components: [{ name: "app", repo: "app" }],
			fs: fakeFs(paths, { "/workspace/project/app": [...cappedEntries, "ignored.ts"] }),
		});
		expect(capped.components[0]!.languages).toEqual([]);
	});

	it("fails closed for unavailable roots and corrupt stored snapshots", () => {
		expect(() => buildProjectImportDecisionContext({
			project,
			importId: "import-1",
			components: [],
			fs: fakeFs({}),
		})).toThrow(ProjectImportDecisionContextError);
		expect(() => buildProjectImportDecisionContext({
			project,
			importId: "a".repeat(129),
			components: [],
			fs: fakeFs({ "/links/project": "/workspace/project" }),
		})).toThrow(expect.objectContaining({ code: "PROJECT_IMPORT_CONTEXT_UNAVAILABLE" }));
		expect(() => buildProjectImportDecisionContext({
			project,
			importId: "import-1",
			components: [],
			fs: fakeFs({ "/links/project": `/${"a".repeat(4_096)}` }),
		})).toThrow(expect.objectContaining({ code: "PROJECT_IMPORT_CONTEXT_UNAVAILABLE" }));
		expect(() => validateProjectImportDecisionContext({
			event: "projectImported",
			projectId: "project-1",
			importId: "import-1",
			projectRoot: "/workspace/project",
			ownedRoots: ["/workspace/project"],
			components: [{ id: "component-0-test", root: "/workspace/project", languages: ["not-a-language"] }],
		})).toThrow(expect.objectContaining({ code: "PROJECT_IMPORT_CONTEXT_UNAVAILABLE" }));
	});
});
