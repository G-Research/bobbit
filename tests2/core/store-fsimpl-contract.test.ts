import path from "node:path";
import { describe, expect, it } from "vitest";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import { PrStatusStore } from "../../src/server/agent/pr-status-store.js";
import { ReviewAnnotationStore } from "../../src/server/review-annotation-store.js";
import { createMemFs } from "../harness/mem-fs.js";

describe("store fsImpl contract", () => {
	it("writes selected stores through the injected fs", () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/state");

		new PreferencesStore(stateDir, memfs).set("theme", "dark");
		new PrStatusStore(stateDir, memfs).set("goal-1", { state: "OPEN", url: "https://example.invalid/pr/1" });
		new ReviewAnnotationStore(stateDir, memfs).addAnnotation("session-1", "Doc", { id: "a1", quote: "q", comment: "c" });

		expect(memfs.files.has(path.join(stateDir, "preferences.json"))).toBe(true);
		expect(memfs.files.has(path.join(stateDir, "pr-status-cache.json"))).toBe(true);
		expect(memfs.files.has(path.join(stateDir, "review-annotations-session-1.json"))).toBe(true);
	});

	it("reloads selected stores from the injected fs", () => {
		const memfs = createMemFs();
		const stateDir = path.resolve("/memfs/reload-state");

		new PreferencesStore(stateDir, memfs).set("theme", "dark");
		new PrStatusStore(stateDir, memfs).set("goal-1", { state: "OPEN", url: "https://example.invalid/pr/1" });
		new ReviewAnnotationStore(stateDir, memfs).addAnnotation("session-1", "Doc", { id: "a1", quote: "q", comment: "c" });

		expect(new PreferencesStore(stateDir, memfs).get("theme")).toBe("dark");
		expect(new PrStatusStore(stateDir, memfs).get("goal-1")?.url).toBe("https://example.invalid/pr/1");
		expect(new ReviewAnnotationStore(stateDir, memfs).getAll("session-1").annotations.Doc).toHaveLength(1);
	});
});
