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
type EntrySource = string[] | { readonly names: readonly string[]; readonly throwAt: number };

interface FsTrace {
	readonly opened: string[];
	readonly closed: string[];
	readonly realpaths: string[];
	reads: number;
}

function fixturePath(...parts: string[]): string {
	return path.resolve(path.parse(process.cwd()).root, "bobbit-project-import-context", ...parts);
}

function fakeFs(paths: Record<string, string>, entries: Record<string, EntrySource> = {}, trace: FsTrace = {
	opened: [], closed: [], realpaths: [], reads: 0,
}): NonNullable<FakeFs> {
	return {
		realpathSync(candidate) {
			const key = path.resolve(String(candidate));
			trace.realpaths.push(key);
			const resolved = paths[key];
			if (!resolved) throw new Error("ENOENT");
			return resolved;
		},
		opendirSync(candidate) {
			const root = String(candidate);
			const source = entries[root];
			if (!source) throw new Error("ENOENT");
			const names = Array.isArray(source) ? source : source.names;
			let index = 0;
			trace.opened.push(root);
			return {
				readSync() {
					trace.reads++;
					if (!Array.isArray(source) && index === source.throwAt) throw new Error("read failure");
					const name = names[index++];
					return name === undefined ? null : { name };
				},
				closeSync() { trace.closed.push(root); },
			};
		},
	} as NonNullable<FakeFs>;
}

const projectRoot = fixturePath("workspace", "project");
const project = { id: "project-1", rootPath: fixturePath("links", "project") };

describe("project import decision context", () => {
	it("canonicalizes the project, rejects symlink escapes, and exposes only owned roots", () => {
		const ownedRoot = path.join(projectRoot, "apps", "owned");
		const fs = fakeFs({
			[project.rootPath]: projectRoot,
			[ownedRoot]: ownedRoot,
			[path.join(projectRoot, "apps", "escape")]: fixturePath("outside", "secret"),
		}, { [ownedRoot]: ["index.ts"] });
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
			projectRoot,
			ownedRoots: [projectRoot, ownedRoot],
			components: [{ root: ownedRoot, languages: ["typescript"] }],
		});
		expect(context.components[0]!.id).toMatch(/^component-0-[a-z2-7]+$/);
		expect(Object.isFrozen(context)).toBe(true);
		expect(Object.isFrozen(context.components)).toBe(true);
		expect(Object.isFrozen(context.components[0]!)).toBe(true);
	});

	it("bounds component work before filesystem access and retains deterministic selected identities", () => {
		const paths: Record<string, string> = { [project.rootPath]: projectRoot };
		const components = Array.from({ length: MAX_PROJECT_IMPORT_COMPONENTS + 5 }, (_, index) => {
			const repo = `packages/${String(MAX_PROJECT_IMPORT_COMPONENTS + 5 - index).padStart(2, "0")}`;
			const root = path.join(projectRoot, repo);
			paths[root] = root;
			return { name: `untrusted display ${index}`, repo };
		});
		const trace: FsTrace = { opened: [], closed: [], realpaths: [], reads: 0 };
		const selectedEntries = Object.fromEntries(components.slice(0, MAX_PROJECT_IMPORT_COMPONENTS).map(component => [path.join(projectRoot, component.repo), []]));
		const context = buildProjectImportDecisionContext({ project, importId: "import-1", components, fs: fakeFs(paths, selectedEntries, trace) });
		expect(context.components).toHaveLength(MAX_PROJECT_IMPORT_COMPONENTS);
		expect(context.components.map(component => component.root)).toEqual([...context.components.map(component => component.root)].sort());
		expect(context.components.map(component => component.id).join(" ")).not.toContain("untrusted display");
		expect(trace.realpaths).toEqual([project.rootPath, ...components.slice(0, MAX_PROJECT_IMPORT_COMPONENTS).map(component => path.join(projectRoot, component.repo))]);
		expect(trace.opened).toHaveLength(MAX_PROJECT_IMPORT_COMPONENTS);
		const second = buildProjectImportDecisionContext({ project, importId: "import-1", components, fs: fakeFs(paths) });
		expect(second.components.map(component => component.id)).toEqual(context.components.map(component => component.id));
	});

	it("incrementally reads no more than the direct entry bound and always closes the directory", () => {
		const appRoot = path.join(projectRoot, "app");
		const paths = { [project.rootPath]: projectRoot, [appRoot]: appRoot };
		const allExtensions = [
			"a.c", "a.cpp", "a.cs", "a.dart", "a.ex", "a.go", "a.hs", "a.java", "a.js", "a.kt",
			"a.lua", "a.php", "a.py", "a.rb", "a.rs", "a.scala", "a.sh", "a.sql", "a.swift", "a.ts",
		];
		const trace: FsTrace = { opened: [], closed: [], realpaths: [], reads: 0 };
		const context = buildProjectImportDecisionContext({
			project, importId: "import-1", components: [{ name: "app", repo: "app" }],
			fs: fakeFs(paths, { [appRoot]: allExtensions }, trace),
		});
		expect(context.components[0]!.languages).toEqual([...DETECTED_PROJECT_LANGUAGES].sort().slice(0, 12));
		expect(trace.opened).toEqual([appRoot]);
		expect(trace.closed).toEqual([appRoot]);

		const cappedTrace: FsTrace = { opened: [], closed: [], realpaths: [], reads: 0 };
		const cappedEntries = Array.from({ length: MAX_PROJECT_IMPORT_ROOT_ENTRIES }, (_, index) => `entry-${index}`);
		const capped = buildProjectImportDecisionContext({
			project, importId: "import-1", components: [{ name: "app", repo: "app" }],
			fs: fakeFs(paths, { [appRoot]: [...cappedEntries, "ignored.ts"] }, cappedTrace),
		});
		expect(capped.components[0]!.languages).toEqual([]);
		expect(cappedTrace.reads).toBe(MAX_PROJECT_IMPORT_ROOT_ENTRIES);
		expect(cappedTrace.closed).toEqual([appRoot]);

		const failingTrace: FsTrace = { opened: [], closed: [], realpaths: [], reads: 0 };
		const failing = buildProjectImportDecisionContext({
			project, importId: "import-1", components: [{ name: "app", repo: "app" }],
			fs: fakeFs(paths, { [appRoot]: { names: ["index.ts"], throwAt: 0 } }, failingTrace),
		});
		expect(failing.components[0]!.languages).toEqual([]);
		expect(failingTrace.closed).toEqual([appRoot]);
	});

	it("fails closed for unavailable roots and corrupt stored snapshots", () => {
		expect(() => buildProjectImportDecisionContext({
			project, importId: "import-1", components: [], fs: fakeFs({}),
		})).toThrow(ProjectImportDecisionContextError);
		expect(() => buildProjectImportDecisionContext({
			project, importId: "a".repeat(129), components: [], fs: fakeFs({ [project.rootPath]: projectRoot }),
		})).toThrow(expect.objectContaining({ code: "PROJECT_IMPORT_CONTEXT_UNAVAILABLE" }));
		expect(() => buildProjectImportDecisionContext({
			project, importId: "import-1", components: [], fs: fakeFs({ [project.rootPath]: `${path.parse(projectRoot).root}${"a".repeat(4_096)}` }),
		})).toThrow(expect.objectContaining({ code: "PROJECT_IMPORT_CONTEXT_UNAVAILABLE" }));
		expect(() => validateProjectImportDecisionContext({
			event: "projectImported", projectId: "project-1", importId: "import-1", projectRoot,
			ownedRoots: [projectRoot],
			components: [{ id: "component-0-test", root: projectRoot, languages: ["not-a-language"] }],
		})).toThrow(expect.objectContaining({ code: "PROJECT_IMPORT_CONTEXT_UNAVAILABLE" }));
	});
});
