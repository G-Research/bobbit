/**
 * In-memory Headquarters route fixture.
 *
 * This deliberately stops below the gateway/listener boundary. The fixture feeds
 * route-shaped requests into the same production project resolution, config
 * cascade, preferences, and session-store cores used by the server. Its initial
 * layout is a pre-authored immutable post-migration snapshot, cloned into memfs
 * for each suite. That keeps the Headquarters API contract covered without
 * repeatedly scaffolding packs or touching Defender-scanned NTFS.
 */
import path from "node:path";

import { ConfigCascade, normalizeConfigProjectId } from "../../../src/server/agent/config-cascade.js";
import { PreferencesStore } from "../../../src/server/agent/preferences-store.js";
import {
	HEADQUARTERS_PROJECT_ID,
	HEADQUARTERS_PROJECT_NAME,
	SYSTEM_PROJECT_ID,
	isHeadquartersProject,
	isSystemProject,
	type ProjectRegistry,
	type RegisteredProject,
} from "../../../src/server/agent/project-registry.js";
import { resolveProjectForRequest } from "../../../src/server/agent/resolve-project.js";
import { SessionStore, type PersistedSession } from "../../../src/server/agent/session-store.js";
import { createManualClock } from "../../harness/clock.js";
import { createMemFs, type MemFs } from "../../harness/mem-fs.js";

const SAME_ROOT_PROJECT_ID = "same-root-normal-project";
const SAME_ROOT_PROJECT_NAME = "Original Same Root Project";
const SAME_ROOT_WORKFLOW_ID = "same-root-normal-workflow";
const READ_TOOL_GROUP = "filesystem";

/** Authored once, never mutated; fixtures clone these values into their memfs. */
const IMMUTABLE_SNAPSHOT = Object.freeze({
	preferences: Object.freeze({ subgoalsEnabled: true, showHeadquartersInProjectLists: true }),
	normalConfig: Object.freeze({
		name: SAME_ROOT_PROJECT_NAME,
		same_root_normal_marker: "normal-project-config",
		workflows: Object.freeze({
			[SAME_ROOT_WORKFLOW_ID]: Object.freeze({ id: SAME_ROOT_WORKFLOW_ID, name: "Same Root Normal Workflow", gates: Object.freeze([{ id: "plan", name: "Plan" }]) }),
		}),
	}),
	builtinReadTool: Object.freeze({ name: "read", description: "Read a file", group: READ_TOOL_GROUP, hasRenderer: false }),
});

type SessionStoreMemFs = MemFs & {
	openSync(file: string, flags: string): number;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
};

type JsonResult = { status: number; body: any; text: string };

interface FixtureState {
	memfs: SessionStoreMemFs;
	projects: Map<string, RegisteredProject>;
	preferences: PreferencesStore;
	hqSessions: SessionStore;
	normalSessions: SessionStore;
	serverRoles: any[];
	serverTools: any[];
	configCascade: ConfigCascade;
	sequence: number;
}

export interface CustomGatewayHandle {
	serverRoot: string;
	headquartersDir: string;
	agentDir: string;
	fs: SessionStoreMemFs;
	json(route: string, init?: RequestInit): Promise<JsonResult>;
	readJson(file: string): any;
	restart(): CustomGatewayHandle;
	shutdown(): Promise<void>;
}

export interface CustomGatewayOptions {
	serverRoot?: string;
	showHeadquarters?: boolean;
}

let fixtureSequence = 0;

function createSessionStoreMemFs(): SessionStoreMemFs {
	const memfs = createMemFs() as SessionStoreMemFs;
	let nextFd = 3;
	const fds = new Map<number, string>();
	const writeFileSync = memfs.writeFileSync.bind(memfs);
	memfs.openSync = (file: string) => {
		const fd = nextFd++;
		fds.set(fd, file);
		return fd;
	};
	(memfs as any).writeFileSync = (target: string | number, data: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding) => {
		if (typeof target === "number") {
			const file = fds.get(target);
			if (!file) throw Object.assign(new Error(`EBADF: bad file descriptor, write '${target}'`), { code: "EBADF" });
			return writeFileSync(file, data, encoding as any);
		}
		return writeFileSync(target, data, encoding as any);
	};
	memfs.fsyncSync = () => {};
	memfs.closeSync = (fd: number) => { fds.delete(fd); };
	return memfs;
}

function project(id: string, name: string, rootPath: string, extra: Partial<RegisteredProject> = {}): RegisteredProject {
	return {
		id,
		name,
		rootPath,
		createdAt: 1,
		position: 0,
		colorLight: "#0ea5e9",
		colorDark: "#38bdf8",
		...extra,
	};
}

function writeJson(fs: SessionStoreMemFs, file: string, value: unknown): void {
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function response(status: number, body: any): JsonResult {
	return { status, body, text: JSON.stringify(body) };
}

function cloneSnapshot(serverRoot: string, showHeadquarters: boolean): FixtureState {
	const memfs = createSessionStoreMemFs();
	const headquartersDir = path.join(serverRoot, ".bobbit", "headquarters");
	const hqStateDir = path.join(headquartersDir, "state");
	const hqConfigDir = path.join(headquartersDir, "config");
	const normalStateDir = path.join(serverRoot, ".bobbit", "state");
	const normalConfigDir = path.join(serverRoot, ".bobbit", "config");
	for (const dir of [hqStateDir, hqConfigDir, normalStateDir, normalConfigDir]) memfs.mkdirSync(dir, { recursive: true });

	const records = [
		project(SAME_ROOT_PROJECT_ID, SAME_ROOT_PROJECT_NAME, serverRoot),
		project(HEADQUARTERS_PROJECT_ID, HEADQUARTERS_PROJECT_NAME, headquartersDir, { kind: "headquarters", position: 1 }),
		project(SYSTEM_PROJECT_ID, "System", path.join(hqStateDir, "system-project"), { kind: "system", hidden: true, position: undefined }),
	];
	writeJson(memfs, path.join(hqStateDir, "projects.json"), records);
	writeJson(memfs, path.join(hqStateDir, "preferences.json"), { ...IMMUTABLE_SNAPSHOT.preferences, showHeadquartersInProjectLists: showHeadquarters });
	writeJson(memfs, path.join(normalConfigDir, "project.json"), IMMUTABLE_SNAPSHOT.normalConfig);

	const projects = new Map(records.map((record) => [record.id, record]));
	const serverRoles: any[] = [];
	const serverTools: any[] = [];
	const builtins = {
		getRoles: () => [],
		getTools: () => [{ ...IMMUTABLE_SNAPSHOT.builtinReadTool }],
		getToolGroupPolicies: () => ({}),
	} as any;
	const serverStores = {
		getRoles: () => serverRoles,
		getTools: () => serverTools,
		getToolGroupPolicies: () => ({}),
	} as any;
	const projectContexts = { getOrCreate: () => undefined } as any;
	const missingPackRoot = path.join(serverRoot, "immutable-empty-pack-root");
	const configCascade = new ConfigCascade(builtins, serverStores, projectContexts, undefined, undefined, missingPackRoot, missingPackRoot);
	const clock = createManualClock(1_700_000_000_000);
	return {
		memfs,
		projects,
		preferences: new PreferencesStore(hqStateDir, memfs),
		hqSessions: new SessionStore(hqStateDir, memfs, clock),
		normalSessions: new SessionStore(normalStateDir, memfs, clock),
		serverRoles,
		serverTools,
		configCascade,
		sequence: 0,
	};
}

function makeHandle(serverRoot: string, state: FixtureState): CustomGatewayHandle {
	const headquartersDir = path.join(serverRoot, ".bobbit", "headquarters");
	const agentDir = path.join(headquartersDir, "agent");
	const registry = { get: (id: string) => state.projects.get(id) } as ProjectRegistry;

	const json = async (route: string, init: RequestInit = {}): Promise<JsonResult> => {
		const url = new URL(route, "http://headquarters.test");
		const method = init.method ?? "GET";
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;

		if (url.pathname === "/api/projects" && method === "GET") {
			const visible = [...state.projects.values()].filter((entry) => {
				if (entry.hidden || isSystemProject(entry)) return false;
				return !isHeadquartersProject(entry) || state.preferences.get("showHeadquartersInProjectLists") !== false;
			});
			return response(200, visible);
		}
		const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
		if (projectMatch && method === "GET") {
			const found = state.projects.get(decodeURIComponent(projectMatch[1]));
			return found ? response(200, found) : response(404, { error: "Project not found" });
		}
		const configMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/config$/);
		if (configMatch && method === "GET") {
			const id = decodeURIComponent(configMatch[1]);
			return response(200, id === SAME_ROOT_PROJECT_ID ? { ...IMMUTABLE_SNAPSHOT.normalConfig } : {});
		}
		if (url.pathname === "/api/preferences" && method === "PUT") {
			for (const [key, value] of Object.entries(body ?? {})) state.preferences.set(key as any, value as any);
			return response(200, state.preferences.getAll());
		}
		if (url.pathname === "/api/sessions" && method === "POST") {
			const resolved = resolveProjectForRequest(registry, { projectId: body?.projectId });
			if (!resolved.ok) return response(resolved.status, { error: resolved.error, code: resolved.code });
			const now = 1_700_000_000_000 + ++state.sequence;
			const session: PersistedSession = {
				id: `headquarters-fixture-${state.sequence}`,
				title: "Quick Session",
				cwd: resolved.project.rootPath,
				agentSessionFile: "",
				createdAt: now,
				lastActivity: now,
				projectId: resolved.projectId,
			};
			const store = resolved.projectId === HEADQUARTERS_PROJECT_ID ? state.hqSessions : state.normalSessions;
			store.put(session);
			return response(201, store.get(session.id));
		}
		if (url.pathname === "/api/roles" && method === "POST") {
			const requested = body?.projectId === SYSTEM_PROJECT_ID ? HEADQUARTERS_PROJECT_ID : body?.projectId;
			if (normalizeConfigProjectId(requested) !== undefined) return response(404, { error: "Project role fixture only covers server scope" });
			const role = { ...body };
			delete role.projectId;
			state.serverRoles.push(role);
			state.memfs.writeFileSync(path.join(headquartersDir, "config", "roles", `${role.name}.yaml`), `name: ${role.name}\nlabel: ${role.label}\npromptTemplate: ${role.promptTemplate}\n`, "utf-8");
			return response(201, role);
		}
		if (url.pathname === "/api/roles" && method === "GET") {
			const projectId = url.searchParams.get("projectId") ?? undefined;
			return response(200, { roles: state.configCascade.resolveRoles(projectId).map((entry) => ({ ...entry.item, origin: entry.origin })) });
		}
		const customizeMatch = url.pathname.match(/^\/api\/tools\/([^/]+)\/customize$/);
		if (customizeMatch && method === "POST") {
			const requested = url.searchParams.get("projectId") === SYSTEM_PROJECT_ID ? HEADQUARTERS_PROJECT_ID : url.searchParams.get("projectId") ?? undefined;
			if (normalizeConfigProjectId(requested) !== undefined) return response(404, { error: "Project tool fixture only covers server scope" });
			const name = decodeURIComponent(customizeMatch[1]);
			const builtin = state.configCascade.resolveTools().find((entry) => entry.item.name === name)?.item;
			if (!builtin) return response(404, { error: "Tool not found" });
			state.serverTools.push({ ...builtin });
			state.memfs.writeFileSync(path.join(headquartersDir, "config", "tools", builtin.group, `${name}.yaml`), `name: ${name}\ndescription: ${builtin.description}\ngroup: ${builtin.group}\n`, "utf-8");
			return response(201, { ...builtin, groupDir: builtin.group });
		}
		return response(404, { error: `Unhandled fixture route: ${method} ${url.pathname}` });
	};

	return {
		serverRoot,
		headquartersDir,
		agentDir,
		fs: state.memfs,
		json,
		readJson(file: string) { return JSON.parse(String(state.memfs.readFileSync(file, "utf-8"))); },
		restart: () => makeHandle(serverRoot, state),
		shutdown: async () => {},
	};
}

export function startCustomGateway(options: CustomGatewayOptions = {}): CustomGatewayHandle {
	const serverRoot = options.serverRoot ?? path.resolve(`/memfs/headquarters-api-${++fixtureSequence}`);
	return makeHandle(serverRoot, cloneSnapshot(serverRoot, options.showHeadquarters ?? true));
}
