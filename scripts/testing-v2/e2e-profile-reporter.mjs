import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const E2E_PROFILE_SCHEMA = 2;
export const E2E_ATTRIBUTION_CATEGORIES = Object.freeze([
	"fixtureSetup",
	"testBody",
	"teardown",
	"buildCache",
	"subprocess",
	"filesystem",
	"gateway",
	"browser",
]);
export const E2E_PROFILE_BUILD_CACHE_LABELS = Object.freeze({
	packagedNpmLockOnly: "profile:build-cache:npm-lock-only",
	packagedNpmCi: "profile:build-cache:npm-ci",
});

const finite = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const emptyAttribution = () => Object.fromEntries(E2E_ATTRIBUTION_CATEGORIES.map((key) => [key, 0]));
const posix = (value) => String(value ?? "").replace(/\\/g, "/");

export function categoryForE2EProfileStep(step) {
	const title = String(step?.title ?? "");
	const category = String(step?.category ?? "");
	if (/after hooks?|teardown/i.test(title)) return "teardown";
	if (/before hooks?|setup|fixture/i.test(title) || category === "fixture") return "fixtureSetup";
	if (/profile:build-cache|build|compile|transform|cache|npm (?:ci|install|pack|lock-only|package-lock-only)/i.test(title)) return "buildCache";
	if (/\b(?:spawn|exec|process|command|git|docker|npm|node)\b/i.test(title)) return "subprocess";
	if (/\b(?:file|filesystem|read|write|copy|remove|mkdir|stat)\b/i.test(title)) return "filesystem";
	if (/\b(?:gateway|server|api request|fetch|websocket|health)\b/i.test(title)) return "gateway";
	if (category === "pw:api" || /\b(?:page|browser|locator|chromium)\b/i.test(title)) return "browser";
	return null;
}

function timestamp(value, fallback) {
	if (value instanceof Date) return value.getTime();
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function topLevelLifecycle(steps, resultStartedAt, resultDurationMs) {
	let fixtureSetup = 0;
	let teardown = 0;
	let startedAt = resultStartedAt;
	let endedAt = resultStartedAt + finite(resultDurationMs);
	for (const step of steps ?? []) {
		const durationMs = finite(step.duration);
		const stepStartedAt = timestamp(step.startTime, resultStartedAt);
		startedAt = Math.min(startedAt, stepStartedAt);
		endedAt = Math.max(endedAt, stepStartedAt + durationMs);
		const category = categoryForE2EProfileStep(step);
		if (category === "fixtureSetup") fixtureSetup += durationMs;
		else if (category === "teardown") teardown += durationMs;
	}
	const wallMs = Math.max(0, endedAt - startedAt);
	return {
		startedAt,
		endedAt,
		fixtureSetup,
		teardown,
		testBody: Math.max(0, wallMs - fixtureSetup - teardown),
	};
}

function leafActivity(steps, out = emptyAttribution()) {
	for (const step of steps ?? []) {
		if (Array.isArray(step.steps) && step.steps.length > 0) leafActivity(step.steps, out);
		else {
			const category = categoryForE2EProfileStep(step);
			if (category && !["fixtureSetup", "teardown", "testBody"].includes(category)) out[category] += finite(step.duration);
		}
	}
	return out;
}

function listArtifactFiles(root, suffixes) {
	if (!root || !existsSync(root)) return [];
	const output = [];
	const stack = [root];
	while (stack.length > 0) {
		const directory = stack.pop();
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) output.push(path);
		}
	}
	return output.sort((a, b) => a.localeCompare(b, "en"));
}

function readJsonLines(root) {
	const records = [];
	const artifacts = listArtifactFiles(root, [".jsonl"]);
	let parseErrors = 0;
	for (const path of artifacts) {
		for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			try { records.push({ ...JSON.parse(line), __artifact: path }); } catch { parseErrors += 1; }
		}
	}
	return { records, artifacts, parseErrors };
}

function processAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return error?.code === "EPERM"; }
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wait briefly for a child observed alive in its owner's synchronous exit hook.
 * The reporter runs after the owner process has closed, so stdio-bound children
 * normally terminate immediately. A child that remains alive at the deadline is
 * retained as incomplete; this probe never signals or otherwise cleans it up.
 */
export function finalChildLiveness(pid, {
	isAlive = processAlive,
	timeoutMs = 1_000,
	pollMs = 20,
	now = Date.now,
	sleep = sleepSync,
} = {}) {
	const startedAt = now();
	let alive = isAlive(pid);
	while (alive && now() - startedAt < timeoutMs) {
		sleep(Math.min(pollMs, Math.max(1, timeoutMs - (now() - startedAt))));
		alive = isAlive(pid);
	}
	return { alive, checkedAt: now() };
}

/** Reconcile raw child records without equating owner exit with child exit. */
export function reconcileChildProcessRecords(records, {
	checkFinalLiveness = (pid) => finalChildLiveness(pid),
} = {}) {
	const starts = new Map(records.filter((record) => record.type === "start" && record.id).map((record) => [record.id, record]));
	const rawEnds = new Map(records.filter((record) => record.type === "end" && record.id).map((record) => [record.id, record]));
	const identities = new Map(records.filter((record) => record.type === "child_identity" && record.id).map((record) => [record.id, record]));
	const childTerminals = new Map(records.filter((record) => record.type === "child_terminal" && record.id).map((record) => [record.id, record]));
	const ownerLiveness = new Map(records.filter((record) => record.type === "owner_child_liveness" && record.id).map((record) => [record.id, record]));
	const ownerEnds = new Map(records.filter((record) => record.type === "owner_end").map((record) => [Number(record.ownerPid), finite(record.endedAt)]));
	const derivedEnds = new Map();
	const terminalEvidence = [];

	for (const [id, start] of starts) {
		if (rawEnds.has(id)) continue;
		const identity = identities.get(id);
		const childTerminal = childTerminals.get(id);
		const ownerState = ownerLiveness.get(id);
		const ownerPid = Number(start.ownerPid);
		const spawnPid = Number(identity?.childPid);
		const terminalPid = Number(childTerminal?.childPid);
		const creationIdentity = String(identity?.creationIdentity ?? "");
		const identityMatches = Number.isInteger(spawnPid) && spawnPid > 0
			&& creationIdentity.length > 0
			&& String(start.creationIdentity ?? "") === creationIdentity
			&& Number(identity?.ownerPid) === ownerPid;
		const ownerStateMatches = Number(ownerState?.ownerPid) === ownerPid
			&& Number(ownerState?.childPid) === spawnPid
			&& String(ownerState?.creationIdentity ?? "") === creationIdentity;
		// On Windows shell:true makes the directly spawned PID cmd.exe while the
		// fixture terminal record comes from its node.exe descendant. The creation
		// token is inherited by that exact child and remains the join authority.
		const childTerminalMatches = Number.isInteger(terminalPid) && terminalPid > 0
			&& String(childTerminal?.creationIdentity ?? "") === creationIdentity
			&& finite(childTerminal?.endedAt) >= finite(start.startedAt);
		if (!ownerEnds.has(ownerPid) || !identityMatches || (!ownerStateMatches && !childTerminalMatches)) continue;

		const finalPids = [...new Set([spawnPid, ...(childTerminalMatches ? [terminalPid] : [])])];
		const finalChecks = finalPids.map((pid) => ({ pid, ...checkFinalLiveness(pid) }));
		const final = {
			alive: finalChecks.some((check) => check.alive === true),
			checkedAt: Math.max(...finalChecks.map((check) => finite(check.checkedAt))),
		};
		const evidence = {
			type: "verified_terminal",
			source: childTerminalMatches ? "child-exit" : "post-owner-liveness",
			id: String(id),
			ownerPid,
			childPid: childTerminalMatches ? terminalPid : spawnPid,
			spawnPid,
			creationIdentity,
			ownerCheckedAt: ownerStateMatches ? finite(ownerState.checkedAt) : null,
			ownerObservedAlive: ownerStateMatches ? ownerState.alive === true : null,
			childEndedAt: childTerminalMatches ? finite(childTerminal.endedAt) : null,
			exitCode: childTerminalMatches && Number.isInteger(childTerminal.exitCode) ? childTerminal.exitCode : null,
			signal: childTerminalMatches && childTerminal.signal ? String(childTerminal.signal) : null,
			finalCheckedAt: finite(final?.checkedAt),
			finalAlive: final?.alive === true,
		};
		terminalEvidence.push(evidence);
		if (evidence.finalAlive) continue;
		const endedAt = childTerminalMatches
			? finite(childTerminal.endedAt)
			: Math.max(finite(start.startedAt), evidence.finalCheckedAt, ownerEnds.get(ownerPid));
		derivedEnds.set(id, {
			type: "end",
			...start,
			endedAt,
			durationMs: Math.max(0, endedAt - finite(start.startedAt)),
			outcome: childTerminalMatches
				? childTerminal.exitCode === 0 ? "ok" : "failed"
				: "verified-exited-after-owner",
			exitCode: evidence.exitCode ?? undefined,
			signal: evidence.signal ?? undefined,
			terminalEvidence: evidence,
		});
	}

	const ends = new Map([...rawEnds, ...derivedEnds]);
	const completed = [...ends.values()].filter((record) => starts.has(record.id)).map((record) => ({
		startedAt: finite(record.startedAt),
		endedAt: finite(record.endedAt),
		durationMs: finite(record.durationMs),
		executable: String(record.executable ?? "<unknown>"),
		outcome: String(record.outcome ?? "unknown"),
		...(record.terminalEvidence ? { terminalEvidence: record.terminalEvidence } : {}),
	})).filter((record) => record.startedAt > 0 && record.endedAt >= record.startedAt);
	const incompleteRecords = [...starts.values()].filter((record) => !ends.has(record.id)).map((record) => {
		const identity = identities.get(record.id);
		const ownerState = ownerLiveness.get(record.id);
		const evidence = terminalEvidence.find((item) => item.id === String(record.id));
		return {
			id: String(record.id),
			api: String(record.api ?? "unknown"),
			executable: String(record.executable ?? "<unknown>"),
			ownerPid: Number(record.ownerPid) || null,
			childPid: Number(identity?.childPid) || null,
			creationIdentity: identity?.creationIdentity ? String(identity.creationIdentity) : null,
			startedAt: finite(record.startedAt),
			ownerEnded: ownerEnds.has(Number(record.ownerPid)),
			ownerObservedAlive: ownerState?.alive === true,
			finalAlive: evidence?.finalAlive ?? null,
			finalCheckedAt: evidence?.finalCheckedAt ?? null,
		};
	});
	return {
		intervals: completed,
		starts: starts.size,
		ends: ends.size,
		orphanEnds: [...rawEnds.keys()].filter((id) => !starts.has(id)).length,
		incompleteRecords,
		terminalEvidence,
		ownersEnded: ownerEnds.size,
	};
}

function childActivity(root) {
	const jsonLines = readJsonLines(root);
	const activity = reconcileChildProcessRecords(jsonLines.records);
	return {
		...activity,
		parseErrors: jsonLines.parseErrors,
		artifacts: jsonLines.artifacts.length,
		rawRecords: jsonLines.records,
	};
}

const RAW_GROUP_B_SPEC_FILES = new Set([
	"tests/e2e/api/goal-archive-branch-cleanup.api-e2e.spec.ts",
]);

function profiledGatewayOwnerIdentities(childRecords, gatewayCalls, completedOwnerPids) {
	const starts = new Map(childRecords.filter((record) => record.type === "start" && record.id).map((record) => [record.id, record]));
	const ends = new Map(childRecords.filter((record) => record.type === "end" && record.id).map((record) => [record.id, record]));
	const identities = [];
	for (const identity of childRecords.filter((record) => record.type === "child_identity" && record.id)) {
		const start = starts.get(identity.id);
		const end = ends.get(identity.id);
		const pid = Number(identity.childPid);
		const creationIdentity = String(identity.creationIdentity ?? "");
		const startedAt = Number(start?.startedAt);
		const endedAt = Number(end?.endedAt);
		if (!Number.isInteger(pid) || pid <= 0 || !completedOwnerPids.has(pid)
			|| !creationIdentity || creationIdentity !== String(start?.creationIdentity ?? "")
			|| Number(identity.ownerPid) !== Number(start?.ownerPid)
			|| !Number.isFinite(startedAt) || startedAt <= 0
			|| !Number.isFinite(endedAt) || endedAt < startedAt
			|| !gatewayCalls.some((call) => call.ownerPid === pid && call.startedAt >= startedAt && call.endedAt <= endedAt)) continue;
		identities.push({ pid, creationIdentity, startedAt, endedAt });
	}
	return identities;
}

function runtimeLoadActivity(rawRecords, gatewayCalls, completedOwnerArtifacts, {
	expectBundledRuntimeLoads = false,
	ownerIdentities = [],
	rawOwnerAllowance = 0,
	eligibleTestsExist = false,
} = {}) {
	const intervals = [];
	let malformed = 0;
	const ownerCounts = new Map();
	for (const record of rawRecords) {
		const ownerPid = Number(record.ownerPid);
		const workerStartedAt = Number(record.workerStartedAt);
		const startedAt = Number(record.startedAt);
		const endedAt = Number(record.endedAt);
		const durationMs = Number(record.durationMs);
		const ownerIdentity = ownerIdentities.find((identity) => identity.pid === ownerPid
			&& workerStartedAt >= identity.startedAt && endedAt <= identity.endedAt);
		const valid = Number.isInteger(ownerPid) && ownerPid > 0
			&& Number.isFinite(workerStartedAt) && workerStartedAt > 0 && workerStartedAt <= startedAt
			&& Number.isFinite(startedAt) && startedAt > 0
			&& Number.isFinite(endedAt) && endedAt >= startedAt
			&& Number.isFinite(durationMs) && durationMs >= 0
			&& record.mode === "bundle"
			&& typeof record.bundleIdentity === "string" && record.bundleIdentity.length > 0
			&& (record.outcome === "success" || record.outcome === "error")
			&& completedOwnerArtifacts.has(record.__artifact);
		if (!valid) { malformed += 1; continue; }
		const ownerKey = ownerIdentity?.creationIdentity ?? `pid:${ownerPid}`;
		ownerCounts.set(ownerKey, (ownerCounts.get(ownerKey) ?? 0) + 1);
		const firstGateway = gatewayCalls
			.filter((call) => call.ownerPid === ownerPid && (!ownerIdentity
				|| (call.startedAt >= ownerIdentity.startedAt && call.endedAt <= ownerIdentity.endedAt)))
			.sort((a, b) => a.startedAt - b.startedAt)[0] ?? null;
		intervals.push({
			id: String(record.id ?? `${ownerPid}:e2e-runtime-load`),
			ownerPid,
			...(ownerIdentity ? { creationIdentity: ownerIdentity.creationIdentity } : {}),
			workerStartedAt,
			bundleIdentity: record.bundleIdentity,
			mode: record.mode,
			startedAt,
			endedAt,
			durationMs,
			outcome: record.outcome,
			...(record.errorName ? { errorName: String(record.errorName) } : {}),
			startupToLoadMs: Math.max(0, startedAt - workerStartedAt),
			firstGateway: firstGateway ? {
				startedAt: firstGateway.startedAt,
				method: firstGateway.method,
				path: firstGateway.path,
				startupToGatewayMs: Math.max(0, firstGateway.startedAt - workerStartedAt),
				loadEndToGatewayMs: firstGateway.startedAt - endedAt,
			} : null,
		});
	}
	const duplicateOwners = [...ownerCounts.values()].filter((count) => count !== 1).length;
	const errors = intervals.filter((record) => record.outcome === "error").length;
	const successfulOwnerKeys = new Set(intervals.filter((record) => record.outcome === "success")
		.map((record) => record.creationIdentity ?? `pid:${record.ownerPid}`));
	// The reporter can identify profiled worker lifetimes from the parent spawn
	// token and their loopback API calls. It cannot map the deliberately raw
	// real-push project to one particular PID, so subtract that project's bounded
	// one-worker allowance rather than falsely requiring a bundle record from it.
	const expectedOwners = expectBundledRuntimeLoads && eligibleTestsExist
		? Math.max(1, ownerIdentities.length - rawOwnerAllowance)
		: 0;
	const observedOwners = ownerIdentities.length > 0
		? ownerIdentities.filter((identity) => successfulOwnerKeys.has(identity.creationIdentity)).length
		: successfulOwnerKeys.size;
	const missingOwners = Math.max(0, expectedOwners - observedOwners);
	return {
		expectation: expectBundledRuntimeLoads ? "bundled-group-b" : "none",
		expectedOwners,
		observedOwners,
		missingOwners,
		intervals: intervals.sort((a, b) => a.startedAt - b.startedAt),
		records: intervals.length,
		successes: intervals.filter((record) => record.outcome === "success").length,
		errors,
		cumulativeMs: intervals.reduce((sum, record) => sum + record.durationMs, 0),
		unjoinedGatewayRecords: intervals.filter((record) => !record.firstGateway).length,
		incomplete: malformed + duplicateOwners + errors + missingOwners,
	};
}

function gatewayActivity(root, { childRecords = [], group, tests = [], expectBundledRuntimeLoads = false } = {}) {
	const artifacts = listArtifactFiles(root, [".json", ".jsonl"]);
	const jsonLines = readJsonLines(root);
	const ownerArtifacts = new Set(jsonLines.records.map((record) => record.__artifact));
	const completedOwnerRecords = jsonLines.records.filter((record) => record.type === "owner_end");
	const completedOwnerArtifacts = new Set(completedOwnerRecords.map((record) => record.__artifact));
	const completedOwnerPids = new Set(completedOwnerRecords.map((record) => Number(record.ownerPid)).filter((pid) => Number.isInteger(pid) && pid > 0));
	const rawRecords = jsonLines.records.filter((record) => record.type === "gateway_api");
	for (const file of artifacts.filter((path) => path.endsWith(".json") && /gateway-api/i.test(path))) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			rawRecords.push(...(Array.isArray(parsed) ? parsed : parsed.records ?? []));
		} catch { /* optional profiling artifacts never affect the test result */ }
	}
	const unique = new Map();
	for (const record of rawRecords) {
		const durationMs = finite(record.durationMs);
		const endedAt = finite(record.endedAt);
		const startedAt = finite(record.startedAt) || endedAt - durationMs;
		if (endedAt <= 0 || startedAt <= 0 || endedAt < startedAt) continue;
		const key = record.id || [record.ownerPid, record.method, record.path, record.status, startedAt, endedAt, durationMs].join("|");
		unique.set(key, {
			ownerPid: Number(record.ownerPid) || null,
			method: String(record.method ?? ""),
			path: String(record.path ?? ""),
			status: Number(record.status) || 0,
			startedAt,
			endedAt,
			durationMs,
		});
	}
	const intervals = [...unique.values()];
	const ownerIdentities = profiledGatewayOwnerIdentities(childRecords, intervals, completedOwnerPids);
	const normalizedFiles = new Set(tests.map((test) => posix(test.file)));
	const rawOwnerAllowance = group === "B" && [...normalizedFiles].some((file) => RAW_GROUP_B_SPEC_FILES.has(file)) ? 1 : 0;
	const eligibleTestsExist = group === "B" && [...normalizedFiles].some((file) => !RAW_GROUP_B_SPEC_FILES.has(file));
	const runtimeLoads = runtimeLoadActivity(
		jsonLines.records.filter((record) => record.type === "e2e_runtime_load"),
		intervals,
		completedOwnerArtifacts,
		{ expectBundledRuntimeLoads, ownerIdentities, rawOwnerAllowance, eligibleTestsExist },
	);
	return {
		intervals,
		records: unique.size,
		artifacts: artifacts.length,
		ownerArtifacts: ownerArtifacts.size,
		incompleteOwners: Math.max(0, ownerArtifacts.size - completedOwnerArtifacts.size),
		parseErrors: jsonLines.parseErrors + runtimeLoads.incomplete,
		runtimeLoads,
	};
}

function containedDuration(intervals, startedAt, endedAt) {
	return intervals.reduce((sum, interval) => interval.startedAt >= startedAt && interval.endedAt <= endedAt
		? sum + interval.durationMs
		: sum, 0);
}

export function buildE2EProfileManifest({
	group,
	sha,
	productBaselineSha,
	instrumentationSha,
	distState,
	platform,
	arch,
	node,
	status,
	tests,
	childProfileDir,
	hookProfileDir,
	expectBundledRuntimeLoads = false,
	createdAt = new Date().toISOString(),
}) {
	const child = childActivity(childProfileDir);
	const hooks = gatewayActivity(hookProfileDir, {
		childRecords: child.rawRecords,
		group,
		tests,
		expectBundledRuntimeLoads: group === "B" && expectBundledRuntimeLoads,
	});
	const subprocesses = child.intervals;
	const gatewayCalls = hooks.intervals;
	const byFile = new Map();
	for (const test of tests) {
		const file = posix(test.file);
		const current = byFile.get(file) ?? {
			file,
			startedAt: test.startedAt,
			endedAt: test.endedAt,
			wallMs: 0,
			attempts: 0,
			retries: 0,
			failures: 0,
			attributionMs: emptyAttribution(),
		};
		current.startedAt = Math.min(current.startedAt, test.startedAt);
		current.endedAt = Math.max(current.endedAt, test.endedAt);
		current.attempts += 1;
		current.retries += test.retry > 0 ? 1 : 0;
		current.failures += /fail|timedout|interrupt/i.test(test.status) ? 1 : 0;
		for (const category of E2E_ATTRIBUTION_CATEGORIES) current.attributionMs[category] += finite(test.attributionMs[category]);
		current.attributionMs.subprocess += containedDuration(subprocesses, test.startedAt, test.endedAt);
		current.attributionMs.gateway += containedDuration(gatewayCalls, test.startedAt, test.endedAt);
		byFile.set(file, current);
	}
	for (const file of byFile.values()) file.wallMs = Math.max(0, file.endedAt - file.startedAt);
	const files = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file, "en"));
	const uniqueTests = new Set(tests.map((test) => `${posix(test.file)}\0${test.title}`));
	const attributionMs = emptyAttribution();
	for (const file of files) for (const category of E2E_ATTRIBUTION_CATEGORIES) attributionMs[category] += file.attributionMs[category];
	return {
		schema: E2E_PROFILE_SCHEMA,
		kind: "e2e-group-profile",
		group,
		sha,
		productBaselineSha,
		instrumentationSha,
		distState,
		platform,
		arch,
		node,
		status,
		createdAt,
		counts: {
			files: files.length,
			tests: uniqueTests.size,
			attempts: tests.length,
			retries: tests.filter((test) => test.retry > 0).length,
			failures: tests.filter((test) => /fail|timedout|interrupt/i.test(test.status)).length,
		},
		attributionMs,
		files,
		// Retain attempt boundaries so the outer coordinator can rebuild overlays
		// after Playwright and all preloaded workers have exited and flushed.
		attempts: tests,
		processActivity: {
			starts: child.starts,
			completed: subprocesses.length,
			incomplete: child.incompleteRecords.length + child.orphanEnds + child.parseErrors,
			orphanEnds: child.orphanEnds,
			parseErrors: child.parseErrors,
			incompleteRecords: child.incompleteRecords,
			terminalEvidence: child.terminalEvidence,
			artifacts: child.artifacts,
			ownersEnded: child.ownersEnded,
			cumulativeMs: subprocesses.reduce((sum, record) => sum + record.durationMs, 0),
			byExecutable: Object.values(subprocesses.reduce((map, record) => {
				const row = map[record.executable] ??= { executable: record.executable, count: 0, cumulativeMs: 0, failures: 0 };
				row.count += 1;
				row.cumulativeMs += record.durationMs;
				if (!["ok", "verified-exited-after-owner"].includes(record.outcome)) row.failures += 1;
				return map;
			}, {})).sort((a, b) => b.cumulativeMs - a.cumulativeMs),
		},
		hookActivity: {
			records: hooks.records,
			artifacts: hooks.artifacts,
			ownerArtifacts: hooks.ownerArtifacts,
			incompleteOwners: hooks.incompleteOwners,
			parseErrors: hooks.parseErrors,
			runtimeLoads: hooks.runtimeLoads,
		},
		accounting: {
			authority: "diagnostic",
			boundary: "playwright-group-subtree",
			note: "Group CPU is diagnostic only. Qualification CPU and peaks come exclusively from outer measure-subtree PID+creation meters.",
		},
		attribution: {
			lifecycleExclusive: ["fixtureSetup", "testBody", "teardown"],
			activityOverlays: ["buildCache", "subprocess", "filesystem", "gateway", "browser"],
			note: "Activity overlays may overlap lifecycle time. Zero means observed zero, not a missing category; sources identify the observational seam.",
			sources: {
				fixtureSetup: "Playwright top-level fixture/before-hook steps",
				testBody: "test result duration minus top-level fixture/setup and teardown",
				teardown: "Playwright top-level after-hook/teardown steps",
				buildCache: "Playwright leaf steps with profile:build-cache/build/cache/compile/transform/npm labels",
				subprocess: "child-process preload intervals contained by the attempt",
				filesystem: "Playwright leaf steps with filesystem operation labels",
				gateway: "flushed loopback-fetch intervals and Playwright gateway-labelled leaf steps",
				browser: "Playwright pw:api/browser-labelled leaf steps",
			},
		},
	};
}

export function refreshE2EProfileManifest(manifest, { childProfileDir, hookProfileDir }) {
	if (!Array.isArray(manifest?.attempts)) throw new Error("profile attempts are required for post-exit refresh");
	return buildE2EProfileManifest({
		group: manifest.group,
		sha: manifest.sha,
		productBaselineSha: manifest.productBaselineSha,
		instrumentationSha: manifest.instrumentationSha,
		distState: manifest.distState,
		platform: manifest.platform,
		arch: manifest.arch,
		node: manifest.node,
		status: manifest.status,
		tests: manifest.attempts,
		childProfileDir,
		hookProfileDir,
		expectBundledRuntimeLoads: manifest.hookActivity?.runtimeLoads?.expectation === "bundled-group-b",
		createdAt: manifest.createdAt,
	});
}

/** Opt-in Playwright reporter. It is never loaded in ordinary E2E runs. */
export default class E2EProfileReporter {
	constructor() {
		this.tests = [];
	}
	onTestEnd(test, result) {
		const startedAt = result.startTime instanceof Date ? result.startTime.getTime() : Date.now() - finite(result.duration);
		const durationMs = finite(result.duration);
		const lifecycle = topLevelLifecycle(result.steps, startedAt, durationMs);
		const activity = leafActivity(result.steps);
		this.tests.push({
			file: relative(process.cwd(), test.location.file),
			title: test.titlePath().join(" > "),
			status: result.status,
			retry: finite(result.retry),
			startedAt: lifecycle.startedAt,
			endedAt: lifecycle.endedAt,
			durationMs,
			attributionMs: {
				...emptyAttribution(),
				...activity,
				fixtureSetup: lifecycle.fixtureSetup,
				testBody: lifecycle.testBody,
				teardown: lifecycle.teardown,
			},
		});
	}
	async onEnd(result) {
		const output = process.env.BOBBIT_V2_E2E_PROFILE_OUTPUT;
		if (!output) return;
		const manifest = buildE2EProfileManifest({
			group: process.env.BOBBIT_V2_E2E_PROFILE_GROUP,
			sha: process.env.BOBBIT_V2_E2E_PROFILE_SHA,
			productBaselineSha: process.env.BOBBIT_V2_E2E_PRODUCT_BASELINE_SHA,
			instrumentationSha: process.env.BOBBIT_V2_E2E_PROFILE_INSTRUMENTATION_SHA,
			distState: process.env.BOBBIT_V2_E2E_DIST_STATE,
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			status: result.status,
			tests: this.tests,
			childProfileDir: process.env.BOBBIT_V2_CHILD_PROFILE_DIR,
			hookProfileDir: process.env.BOBBIT_V2_HOOK_PROFILE_DIR,
			expectBundledRuntimeLoads: process.env.BOBBIT_V2_E2E_PROFILE_GROUP === "B"
				&& Boolean(process.env.BOBBIT_V2_E2E_DIST_SERVER_PREBUNDLE?.trim()),
		});
		mkdirSync(dirname(output), { recursive: true });
		const temporary = `${output}.tmp-${process.pid}`;
		writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
		renameSync(temporary, output);
	}
}
