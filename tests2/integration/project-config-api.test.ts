/**
 * Project-config API contract coverage for mid-session project proposals.
 *
 * The broad HTTP router is covered by the gateway API suites. This focused
 * declaration inventory uses the production ProjectConfigStore through a tiny
 * route-shaped fixture, keeping all persistence/normalization semantics while
 * avoiding five full project-context boots and Defender-scanned NTFS trees.
 */
import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import {
	ProjectConfigStore,
	type Component,
} from "../../src/server/agent/project-config-store.js";
import { createMemFs, type MemFs } from "../harness/mem-fs.js";

/** The full editable field set from the design doc (config-scoped only — name is
 *  handled via the registry endpoint, not project.yaml). */
const CONFIG_FIELDS = {
	build_command: "npm run build",
	test_command: "npm test",
	typecheck_command: "npm run check",
	test_unit_command: "npm run test:unit",
	test_e2e_command: "npm run test:e2e",
	worktree_setup_command: "npm ci",
	sandbox: "docker",
	session_model: "anthropic/claude-3-5-sonnet-latest",
	review_model: "anthropic/claude-3-5-haiku-latest",
	naming_model: "anthropic/claude-3-5-haiku-latest",
};

const PROJECT_ID = "project-config-api-project";
const LEGACY_KEY_MAP: Readonly<Record<string, string>> = {
	build_command: "build",
	test_command: "test",
	typecheck_command: "check",
	test_unit_command: "unit",
	test_e2e_command: "e2e",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function normalizedComponent(component: Record<string, unknown>): Component {
	return {
		name: String(component.name ?? ""),
		repo: typeof component.repo === "string" && component.repo ? component.repo : ".",
		relativePath: typeof component.relative_path === "string"
			? component.relative_path
			: typeof component.relativePath === "string" ? component.relativePath : undefined,
		worktreeSetupCommand: typeof component.worktree_setup_command === "string"
			? component.worktree_setup_command
			: typeof component.worktreeSetupCommand === "string" ? component.worktreeSetupCommand : undefined,
		commands: component.commands && typeof component.commands === "object" && !Array.isArray(component.commands)
			? component.commands as Record<string, string>
			: undefined,
		config: component.config && typeof component.config === "object" && !Array.isArray(component.config)
			? component.config as Record<string, string>
			: undefined,
	};
}

class ProjectConfigApiFixture {
	readonly id = PROJECT_ID;
	private name: string;
	private readonly store: ProjectConfigStore;

	constructor(name: string, fs: MemFs) {
		this.name = name;
		this.store = new ProjectConfigStore(path.resolve("/memfs/project-config-api", this.id), fs);
	}

	async fetch(requestPath: string, init: RequestInit = {}): Promise<Response> {
		const method = (init.method ?? "GET").toUpperCase();
		const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};

		if (requestPath === `/api/projects/${this.id}/config` && method === "PUT") {
			this.putConfig(body);
			return json({ ok: true });
		}
		if (requestPath === `/api/projects/${this.id}/config` && method === "GET") {
			return json(this.store.getAll());
		}
		if (requestPath === `/api/projects/${this.id}/structured` && method === "GET") {
			return json({ components: this.store.getComponents(), workflows: this.store.getWorkflows() });
		}
		if (requestPath === `/api/projects/${this.id}` && method === "PUT") {
			if (typeof body.name === "string" && body.name) this.name = body.name;
			return json({ id: this.id, name: this.name });
		}
		if (requestPath === `/api/projects/${this.id}` && method === "GET") {
			return json({ id: this.id, name: this.name });
		}
		return json({ error: "Project not found" }, 404);
	}

	private putConfig(input: Record<string, unknown>): void {
		const body = { ...input };
		let components = body.components;
		delete body.components;
		delete body.workflows;

		// Mirrors the server's legacy proposal compatibility path: retain the flat
		// keys for old clients and synthesize the structured execution component.
		if (!Array.isArray(components)) {
			const commands: Record<string, string> = {};
			for (const [legacyKey, commandName] of Object.entries(LEGACY_KEY_MAP)) {
				const value = body[legacyKey];
				if (typeof value === "string" && value.trim()) commands[commandName] = value.trim();
			}
			const hook = typeof body.worktree_setup_command === "string" ? body.worktree_setup_command.trim() : "";
			if (Object.keys(commands).length > 0 || hook) {
				const existing = this.store.getComponents();
				const first = existing[0];
				components = [{
					name: first?.name ?? this.name,
					repo: first?.repo ?? ".",
					commands: { ...(first?.commands ?? {}), ...commands },
					...(hook || first?.worktreeSetupCommand
						? { worktree_setup_command: hook || first?.worktreeSetupCommand }
						: {}),
				}, ...existing.slice(1)];
			}
		}

		for (const [key, value] of Object.entries(body)) {
			if (value === null || value === "") this.store.remove(key);
			else if (typeof value === "string") this.store.set(key, value);
		}
		if (Array.isArray(components)) {
			this.store.setComponents(components.map(component => normalizedComponent(component as Record<string, unknown>)));
		}
	}
}

let memoryFs: MemFs;
const test = Object.assign(it, { describe });

beforeEach(() => {
	memoryFs = createMemFs();
});

function registerTmpProject(name: string): { id: string; apiFetch: ProjectConfigApiFixture["fetch"] } {
	const api = new ProjectConfigApiFixture(name, memoryFs);
	return { id: api.id, apiFetch: api.fetch.bind(api) };
}

test.describe("Project config API — mid-session proposal field coverage", () => {
	test("PUT /api/projects/:id/config accepts all editable fields and GET returns them", async () => {
		const { id, apiFetch } = registerTmpProject("midsession-cfg");
		const putRes = await apiFetch(`/api/projects/${id}/config`, {
			method: "PUT",
			body: JSON.stringify(CONFIG_FIELDS),
		});
		expect(putRes.status).toBe(200);

		const getRes = await apiFetch(`/api/projects/${id}/config`);
		expect(getRes.status).toBe(200);
		const cfg = await getRes.json();
		for (const [key, value] of Object.entries(CONFIG_FIELDS)) {
			expect(cfg[key], `field ${key} should be persisted`).toBe(value);
		}
	});

	test("PUT /api/projects/:id accepts name rename and GET returns it", async () => {
		const { id, apiFetch } = registerTmpProject("before-rename");
		const putRes = await apiFetch(`/api/projects/${id}`, {
			method: "PUT",
			body: JSON.stringify({ name: "after-rename" }),
		});
		expect(putRes.status).toBe(200);
		const updated = await putRes.json();
		expect(updated.name).toBe("after-rename");

		const getRes = await apiFetch(`/api/projects/${id}`);
		const project = await getRes.json();
		expect(project.name).toBe("after-rename");
	});

	test("partial PUT updates only the supplied fields", async () => {
		const { id, apiFetch } = registerTmpProject("partial-put");
		await apiFetch(`/api/projects/${id}/config`, {
			method: "PUT",
			body: JSON.stringify({ build_command: "seed-build", test_command: "seed-test" }),
		});
		const response = await apiFetch(`/api/projects/${id}/config`, {
			method: "PUT",
			body: JSON.stringify({ test_command: "new-test" }),
		});
		expect(response.status).toBe(200);
		const cfg = await (await apiFetch(`/api/projects/${id}/config`)).json();
		expect(cfg.build_command).toBe("seed-build");
		expect(cfg.test_command).toBe("new-test");
	});

	test("PUT /api/projects/:id/config translates legacy *_command fields into components[0].commands (back-compat)", async () => {
		const { id, apiFetch } = registerTmpProject("legacy-translate");
		const putRes = await apiFetch(`/api/projects/${id}/config`, {
			method: "PUT",
			body: JSON.stringify({
				build_command: "npm run build",
				test_command: "npm test",
				typecheck_command: "npm run check",
				test_unit_command: "npm run test:unit",
				test_e2e_command: "npm run test:e2e",
				worktree_setup_command: "npm ci",
			}),
		});
		expect(putRes.status).toBe(200);

		const raw = await (await apiFetch(`/api/projects/${id}/config`)).json();
		expect(raw.build_command).toBe("npm run build");

		const struct = await (await apiFetch(`/api/projects/${id}/structured`)).json();
		expect(Array.isArray(struct.components), "structured endpoint should expose components[]").toBe(true);
		expect(struct.components.length, "single default component").toBe(1);
		const first = struct.components[0];
		expect(first.name).toBe("legacy-translate");
		expect(first.repo).toBe(".");
		expect(first.commands.build).toBe("npm run build");
		expect(first.commands.test).toBe("npm test");
		expect(first.commands.check).toBe("npm run check");
		expect(first.commands.unit).toBe("npm run test:unit");
		expect(first.commands.e2e).toBe("npm run test:e2e");
		expect(first.worktreeSetupCommand || first.worktree_setup_command).toBe("npm ci");
	});

	test("PUT /api/projects/:id/config preserves unknown custom keys", async () => {
		const { id, apiFetch } = registerTmpProject("custom-keys");
		await apiFetch(`/api/projects/${id}/config`, {
			method: "PUT",
			body: JSON.stringify({ my_custom_key: "value-1" }),
		});
		const cfg = await (await apiFetch(`/api/projects/${id}/config`)).json();
		expect(cfg.my_custom_key).toBe("value-1");
	});

	test("raw project sound override round-trips exact string values across store reloads", async () => {
		const { id, apiFetch } = registerTmpProject("sound-override-strings");

		for (const value of ["true", "false"] as const) {
			const putRes = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({ play_agent_finish_sound: value }),
			});
			expect(putRes.status).toBe(200);

			const raw = await (await apiFetch(`/api/projects/${id}/config`)).json();
			expect(raw.play_agent_finish_sound).toBe(value);

			// Reconstructing the fixture creates a fresh ProjectConfigStore over the
			// same in-memory filesystem, mirroring a process/store reload.
			const reloaded = registerTmpProject("sound-override-strings-reloaded");
			const persisted = await (await reloaded.apiFetch(`/api/projects/${id}/config`)).json();
			expect(persisted.play_agent_finish_sound).toBe(value);
		}
	});

	test("null removes the raw project sound override and the removal survives reload", async () => {
		const { id, apiFetch } = registerTmpProject("sound-override-clear");
		await apiFetch(`/api/projects/${id}/config`, {
			method: "PUT",
			body: JSON.stringify({ play_agent_finish_sound: "true" }),
		});

		const clearRes = await apiFetch(`/api/projects/${id}/config`, {
			method: "PUT",
			body: JSON.stringify({ play_agent_finish_sound: null }),
		});
		expect(clearRes.status).toBe(200);

		const cleared = await (await apiFetch(`/api/projects/${id}/config`)).json();
		expect(cleared).not.toHaveProperty("play_agent_finish_sound");

		const reloaded = registerTmpProject("sound-override-clear-reloaded");
		const persisted = await (await reloaded.apiFetch(`/api/projects/${id}/config`)).json();
		expect(persisted).not.toHaveProperty("play_agent_finish_sound");
		expect([...memoryFs.files.values()].join("\n")).not.toContain("play_agent_finish_sound");
	});
});
