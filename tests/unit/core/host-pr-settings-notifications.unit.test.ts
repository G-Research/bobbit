import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	PrStatusPersistenceError,
	PrStatusStore,
	type PrStatusChangedFact,
} from "../../../src/server/agent/pr-status-store.js";
import {
	ProjectConfigPersistenceError,
	ProjectConfigStore,
	type ProjectSettingsChangedFact,
} from "../../../src/server/agent/project-config-store.js";
import { createMemFs, type MemFs } from "../../../tests2/harness/mem-fs.js";

function siblingTemp(file: string, candidate: string): boolean {
	return path.dirname(candidate) === path.dirname(file)
		&& candidate !== file
		&& path.basename(candidate).startsWith(`${path.basename(file)}.`);
}

function text(fs: MemFs, file: string): string {
	return String(fs.readFileSync(file, "utf-8"));
}

describe("authoritative PR and settings notification facts", () => {
	it("publishes a bounded PR projection only after atomic commit and suppresses safe no-ops", () => {
		const fs = createMemFs();
		const stateDir = path.resolve("/memfs/host-pr-facts");
		const storeFile = path.join(stateDir, "pr-status-cache.json");
		const store = new PrStatusStore(stateDir, fs);
		const facts: PrStatusChangedFact[] = [];
		let committed = false;
		const originalRename = fs.renameSync.bind(fs);
		(fs as any).renameSync = (from: string, to: string) => {
			originalRename(from, to);
			if (to === storeFile) committed = true;
		};
		store.onPullRequestStatusChanged = fact => {
			expect(committed).toBe(true);
			facts.push(fact);
		};

		store.set("goal-1", {
			state: "OPEN",
			number: 42,
			reviewDecision: "APPROVED",
			mergeable: "MERGEABLE",
			updatedAt: "2027-03-04T05:06:07.000Z",
			url: "https://user:PR_URL_SECRET@example.invalid/pull/42",
			title: "PR_TITLE_SECRET",
			headRefName: "PR_BRANCH_SECRET",
			viewerIsAdmin: true,
		});

		expect(facts).toEqual([{
			goalId: "goal-1",
			revision: "2027-03-04T05:06:07.000Z",
			payload: {
				goalId: "goal-1",
				number: 42,
				state: "OPEN",
				reviewDecision: "APPROVED",
				mergeability: "MERGEABLE",
			},
		}]);
		expect(JSON.stringify(facts)).not.toMatch(/PR_URL_SECRET|PR_TITLE_SECRET|PR_BRANCH_SECRET|viewerIsAdmin|url|title/);

		committed = false;
		store.set("goal-1", {
			...store.get("goal-1")!,
			url: "https://example.invalid/pull/changed-sensitive-cache-field",
			title: "changed sensitive cache field",
			updatedAt: "2027-03-04T05:07:00.000Z",
		});
		expect(committed).toBe(true);
		expect(facts).toHaveLength(1);
		expect(store.get("goal-1")?.title).toBe("changed sensitive cache field");
	});

	it("uses a stable SHA-256 revision of the canonical safe PR projection without provider updatedAt", () => {
		const fs = createMemFs();
		const store = new PrStatusStore(path.resolve("/memfs/host-pr-hash"), fs);
		let fact: PrStatusChangedFact | undefined;
		store.onPullRequestStatusChanged = value => { fact = value; };

		store.set("goal-hash", { state: "CLOSED", number: 9, mergeable: "UNKNOWN", title: "not hashed" });

		const payload = { goalId: "goal-hash", number: 9, state: "CLOSED", mergeability: "UNKNOWN" };
		const expected = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
		expect(fact).toEqual({ goalId: "goal-hash", revision: expected, payload });
		expect(fact?.revision).toMatch(/^[a-f0-9]{64}$/);
	});

	it("fails PR persistence loudly without changing cache or publishing a fact", () => {
		const fs = createMemFs();
		const stateDir = path.resolve("/memfs/host-pr-failure");
		const storeFile = path.join(stateDir, "pr-status-cache.json");
		const store = new PrStatusStore(stateDir, fs);
		store.set("goal-1", { state: "OPEN" });
		const beforeBytes = text(fs, storeFile);
		const facts: PrStatusChangedFact[] = [];
		store.onPullRequestStatusChanged = fact => facts.push(fact);
		const originalRename = fs.renameSync.bind(fs);
		(fs as any).renameSync = (from: string, to: string) => {
			if (to === storeFile) throw new Error("PR_PERSISTENCE_SECRET");
			return originalRename(from, to);
		};

		expect(() => store.set("goal-1", { state: "MERGED" })).toThrow(PrStatusPersistenceError);
		expect(store.get("goal-1")).toEqual({ state: "OPEN" });
		expect(text(fs, storeFile)).toBe(beforeBytes);
		expect(facts).toEqual([]);
		expect([...fs.files.keys()].filter(file => siblingTemp(storeFile, file))).toEqual([]);
	});

	it("publishes sorted setting identifiers and the exact committed-byte hash after rename", () => {
		const fs = createMemFs();
		const configDir = path.resolve("/memfs/host-settings-facts");
		const configFile = path.join(configDir, "project.yaml");
		const store = new ProjectConfigStore(configDir, fs);
		const facts: ProjectSettingsChangedFact[] = [];
		let committed = false;
		const originalRename = fs.renameSync.bind(fs);
		(fs as any).renameSync = (from: string, to: string) => {
			originalRename(from, to);
			if (to === configFile) committed = true;
		};
		store.onSettingsChanged = fact => {
			expect(committed).toBe(true);
			facts.push(fact);
		};

		store.mutate(draft => {
			draft.set("test_command", "SETTINGS_VALUE_SECRET");
			draft.set("build_command", "BUILD_VALUE_SECRET");
			draft.setSandboxTokens([{ key: "DEPLOY_TOKEN", enabled: true, value: "TOKEN_VALUE_SECRET" }]);
		});

		const committedBytes = text(fs, configFile);
		expect(facts).toEqual([{
			revision: createHash("sha256").update(committedBytes).digest("hex"),
			payload: {
				target: "project",
				changedKeys: ["build_command", "sandbox_tokens", "test_command"],
			},
		}]);
		expect(JSON.stringify(facts)).not.toMatch(/SETTINGS_VALUE_SECRET|BUILD_VALUE_SECRET|TOKEN_VALUE_SECRET/);
		expect(committedBytes).not.toContain("TOKEN_VALUE_SECRET");
	});

	it("suppresses settings no-ops and changes to non-durable secret values", () => {
		const fs = createMemFs();
		const store = new ProjectConfigStore(path.resolve("/memfs/host-settings-noop"), fs);
		const facts: ProjectSettingsChangedFact[] = [];
		store.onSettingsChanged = fact => facts.push(fact);
		store.set("build_command", "npm run build");
		store.setSandboxTokens([{ key: "DEPLOY_TOKEN", enabled: true, value: "first secret" }]);
		expect(facts).toHaveLength(2);

		store.set("build_command", "npm run build");
		store.setSandboxTokens([{ key: "DEPLOY_TOKEN", enabled: true, value: "second secret" }]);

		expect(facts).toHaveLength(2);
	});

	it("does not publish settings when the atomic commit fails", () => {
		const fs = createMemFs();
		const configDir = path.resolve("/memfs/host-settings-failure");
		const configFile = path.join(configDir, "project.yaml");
		const store = new ProjectConfigStore(configDir, fs);
		store.set("build_command", "before");
		const beforeBytes = text(fs, configFile);
		const facts: ProjectSettingsChangedFact[] = [];
		store.onSettingsChanged = fact => facts.push(fact);
		const originalRename = fs.renameSync.bind(fs);
		(fs as any).renameSync = (from: string, to: string) => {
			if (to === configFile) throw new Error("SETTINGS_PERSISTENCE_SECRET");
			return originalRename(from, to);
		};

		expect(() => store.set("build_command", "after")).toThrow(ProjectConfigPersistenceError);
		expect(store.get("build_command")).toBe("before");
		expect(text(fs, configFile)).toBe(beforeBytes);
		expect(facts).toEqual([]);
		expect([...fs.files.keys()].filter(file => siblingTemp(configFile, file))).toEqual([]);
	});

	it("isolates post-commit observer failures from both authoritative stores", () => {
		const fs = createMemFs();
		const prStore = new PrStatusStore(path.resolve("/memfs/host-pr-observer-failure"), fs);
		const configStore = new ProjectConfigStore(path.resolve("/memfs/host-settings-observer-failure"), fs);
		prStore.onPullRequestStatusChanged = () => { throw new Error("observer failed"); };
		configStore.onSettingsChanged = () => { throw new Error("observer failed"); };

		expect(() => prStore.set("goal-1", { state: "OPEN" })).not.toThrow();
		expect(() => configStore.set("build_command", "npm run committed")).not.toThrow();
		expect(prStore.get("goal-1")).toEqual({ state: "OPEN" });
		expect(configStore.get("build_command")).toBe("npm run committed");
	});
});
