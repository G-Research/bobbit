#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { E2E_ATTRIBUTION_CATEGORIES, E2E_PROFILE_SCHEMA } from "./e2e-profile-reporter.mjs";

export const E2E_SAMPLE_SCHEMA = 2;
export const E2E_QUALIFICATION_SCHEMA = 2;
export const PRODUCT_BASELINE_SHA = "3a90cf55ab5226249529b00ecb874be4a79d5e54";
export const REQUIRED_GROUPS = Object.freeze(["A", "B", "C", "D"]);
export const REQUIRED_STATES = Object.freeze(["cold", "warm"]);
export const REQUIRED_PLATFORMS = Object.freeze(["linux", "win32", "darwin"]);
export const REQUIRED_VALIDATIONS = Object.freeze([
	"check",
	"unit-contracts",
	"source-theme-browser",
	"raw-bundle-integration",
	"packaged-consumer",
]);

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
const add = (errors, condition, message) => { if (!condition) errors.push(message); };

/** Add the versioned envelope without inventing or defaulting evidence fields. */
export function createE2ESampleManifest(fields) {
	return { schema: E2E_SAMPLE_SCHEMA, kind: "e2e-qualification-sample", productBaselineSha: PRODUCT_BASELINE_SHA, ...fields };
}

export function createE2EQualificationManifest(fields) {
	return { schema: E2E_QUALIFICATION_SCHEMA, kind: "e2e-qualification", productBaselineSha: PRODUCT_BASELINE_SHA, ...fields };
}

export function validateE2EProfileManifest(profile, expected = {}) {
	const errors = [];
	add(errors, object(profile), "profile must be an object");
	if (!object(profile)) return errors;
	add(errors, profile.schema === E2E_PROFILE_SCHEMA, `profile.schema must be ${E2E_PROFILE_SCHEMA}`);
	add(errors, profile.kind === "e2e-group-profile", "profile.kind must be e2e-group-profile");
	add(errors, profile.group === "B" || profile.group === "C", "profile.group must be B or C");
	add(errors, sha(profile.sha), "profile.sha must be a full Git SHA");
	add(errors, sha(profile.productBaselineSha), "profile.productBaselineSha must be a full Git SHA");
	add(errors, sha(profile.instrumentationSha), "profile.instrumentationSha must be a full Git SHA");
	add(errors, REQUIRED_STATES.includes(profile.distState), "profile.distState must be cold or warm");
	add(errors, REQUIRED_PLATFORMS.includes(profile.platform), "profile.platform must be linux, win32, or darwin");
	if (expected.group) add(errors, profile.group === expected.group, `profile group mismatch: expected ${expected.group}`);
	if (expected.sha) add(errors, profile.sha === expected.sha, `profile SHA mismatch: expected ${expected.sha}`);
	if (expected.distState) add(errors, profile.distState === expected.distState, `profile state mismatch: expected ${expected.distState}`);
	if (expected.platform) add(errors, profile.platform === expected.platform, `profile platform mismatch: expected ${expected.platform}`);
	add(errors, object(profile.attributionMs), "profile.attributionMs is required");
	for (const category of E2E_ATTRIBUTION_CATEGORIES) {
		add(errors, finite(profile.attributionMs?.[category]), `profile attribution ${category} is required and numeric`);
		add(errors, typeof profile.attribution?.sources?.[category] === "string", `profile attribution source ${category} is required`);
	}
	add(errors, Array.isArray(profile.files) && profile.files.length > 0, "profile.files must contain per-spec rows");
	for (const [index, file] of (profile.files ?? []).entries()) {
		add(errors, typeof file.file === "string" && file.file.length > 0, `profile.files[${index}].file is required`);
		add(errors, finite(file.wallMs), `profile.files[${index}].wallMs is required`);
		for (const category of E2E_ATTRIBUTION_CATEGORIES)
			add(errors, finite(file.attributionMs?.[category]), `profile.files[${index}] attribution ${category} is required`);
	}
	add(errors, finite(profile.counts?.attempts), "profile counts.attempts is required");
	add(errors, finite(profile.counts?.retries), "profile counts.retries is required");
	add(errors, finite(profile.counts?.failures), "profile counts.failures is required");
	add(errors, Array.isArray(profile.attempts) && profile.attempts.length === Number(profile.counts?.attempts), "profile attempt boundaries are incomplete");
	add(errors, finite(profile.processActivity?.starts) && Number(profile.processActivity.starts) > 0, "profile child-process starts are required");
	add(errors, finite(profile.processActivity?.completed), "profile completed child-process count is required");
	add(errors, Number(profile.processActivity?.incomplete) === 0, "profile child-process telemetry must have no unmatched starts");
	add(errors, Array.isArray(profile.processActivity?.incompleteRecords) && profile.processActivity.incompleteRecords.length === 0, "profile unmatched child-process records must be empty");
	add(errors, Number(profile.hookActivity?.records) > 0, "profile gateway hook records are required");
	add(errors, Number(profile.hookActivity?.artifacts) > 0, "profile gateway hook artifacts are required");
	add(errors, Number(profile.hookActivity?.incompleteOwners) === 0, "profile gateway hook owners must all flush");
	add(errors, profile.accounting?.authority === "diagnostic" && profile.accounting?.boundary === "playwright-group-subtree", "profile accounting must be explicitly diagnostic");
	add(errors, finite(profile.ownedProcess?.cpuMs), "profile ownedProcess.cpuMs is required");
	add(errors, finite(profile.ownedProcess?.peakProcesses), "profile ownedProcess.peakProcesses is required");
	add(errors, profile.ownedProcess?.accounting?.authority === "diagnostic", "profile ownedProcess accounting must be diagnostic");
	add(errors, profile.ownedProcess?.accounting?.method === "pid-creation-subtree", "profile ownedProcess accounting method must be pid-creation-subtree");
	add(errors, Array.isArray(profile.ownedProcess?.processes), "profile ownedProcess.processes identity list is required");
	for (const [index, process] of (profile.ownedProcess?.processes ?? []).entries()) {
		add(errors, Number.isInteger(process.pid) && process.pid > 0, `profile process ${index} pid is invalid`);
		add(errors, finite(process.creation), `profile process ${index} creation identity is required`);
	}
	return errors;
}

function validateTiming(errors, timing, path, { derived = false } = {}) {
	add(errors, object(timing), `${path} is required`);
	for (const field of ["wallMs", "cpuMs", "peakProcesses"])
		add(errors, finite(timing?.[field]), `${path}.${field} is required and numeric`);
	add(errors, timing?.accounting?.authority === (derived ? "outer-derived" : "outer"), `${path} must use authoritative outer accounting`);
	add(errors, timing?.accounting?.method === "pid-creation-subtree", `${path} accounting method must be pid-creation-subtree`);
	add(errors, timing?.accounting?.boundary === (derived ? "prewarm-plus-exact-command" : "spawned-command-subtree"), `${path} accounting boundary is invalid`);
	if (derived) {
		add(errors, Array.isArray(timing?.contributingMeters) && timing.contributingMeters.length === 2, `${path}.contributingMeters must name prewarm and exact-command`);
		return;
	}
	add(errors, Number.isInteger(timing?.rootProcess?.pid) && timing.rootProcess.pid > 0, `${path}.rootProcess.pid is required`);
	add(errors, finite(timing?.rootProcess?.creation), `${path}.rootProcess.creation is required`);
	add(errors, Array.isArray(timing?.processes) && timing.processes.length > 0, `${path}.processes identity list is required`);
	for (const [index, process] of (timing?.processes ?? []).entries()) {
		add(errors, Number.isInteger(process.pid) && process.pid > 0, `${path}.processes[${index}].pid is invalid`);
		add(errors, finite(process.creation), `${path}.processes[${index}].creation is required`);
	}
}

export function validateE2ESampleManifest(sample, {
	loadProfile,
	expectedSha,
	expectedState,
	expectedPlatform,
} = {}) {
	const errors = [];
	add(errors, object(sample), "sample must be an object");
	if (!object(sample)) return errors;
	add(errors, sample.schema === E2E_SAMPLE_SCHEMA, `sample.schema must be ${E2E_SAMPLE_SCHEMA}`);
	add(errors, sample.kind === "e2e-qualification-sample", "sample.kind must be e2e-qualification-sample");
	add(errors, sha(sample.sha), "sample.sha must be a full Git SHA");
	add(errors, sample.productBaselineSha === PRODUCT_BASELINE_SHA, `sample.productBaselineSha must be ${PRODUCT_BASELINE_SHA}`);
	add(errors, sample.variant === "baseline" || sample.variant === "candidate", "sample.variant must be baseline or candidate");
	add(errors, typeof sample.pair?.id === "string" && sample.pair.id.length > 0, "sample.pair.id is required");
	add(errors, Number.isInteger(sample.pair?.index) && sample.pair.index > 0, "sample.pair.index must be a positive integer");
	add(errors, sample.pair?.position === 1 || sample.pair?.position === 2, "sample.pair.position must be 1 or 2");
	add(errors, REQUIRED_STATES.includes(sample.distState), "sample.distState must be cold or warm");
	add(errors, REQUIRED_PLATFORMS.includes(sample.platform), "sample.platform must be linux, win32, or darwin");
	if (expectedSha) add(errors, sample.sha === expectedSha, `sample SHA mismatch: expected ${expectedSha}`);
	if (expectedState) add(errors, sample.distState === expectedState, `sample state mismatch: expected ${expectedState}`);
	if (expectedPlatform) add(errors, sample.platform === expectedPlatform, `sample platform mismatch: expected ${expectedPlatform}`);
	add(errors, typeof sample.setupFingerprint === "string" && sample.setupFingerprint.length >= 16, "sample.setupFingerprint is required");
	for (const field of ["node", "npm", "playwright", "chromiumRevision", "chromiumExecutableSha256", "runnerImage", "cpu", "logicalCores", "ramBytes"])
		add(errors, sample.environment?.[field] !== undefined && sample.environment?.[field] !== "", `sample.environment.${field} is required`);
	add(errors, sample.argv === "npm run test:e2e", "sample.argv must be the exact npm run test:e2e command");
	add(errors, sample.env?.BOBBIT_V2_RETRY_FREE === "1", "sample must set BOBBIT_V2_RETRY_FREE=1");
	add(errors, sample.env?.NODE_DISABLE_COMPILE_CACHE === "1", "sample must retain NODE_DISABLE_COMPILE_CACHE=1");
	add(errors, sample.preparation?.insideMeasuredInterval === false, "provisioning/preparation must be outside the measured interval");
	add(errors, sample.prewarm?.included === true, "prewarm accounting must be included");
	add(errors, sample.snapshotUsed === false, "qualification must not use a snapshot");
	validateTiming(errors, sample.timing?.combined, "sample.timing.combined", { derived: true });
	validateTiming(errors, sample.timing?.prewarm, "sample.timing.prewarm");
	validateTiming(errors, sample.timing?.exactCommand, "sample.timing.exactCommand");
	if (finite(sample.timing?.combined?.cpuMs) && finite(sample.timing?.prewarm?.cpuMs) && finite(sample.timing?.exactCommand?.cpuMs)) {
		const expected = Number(sample.timing.prewarm.cpuMs) + Number(sample.timing.exactCommand.cpuMs);
		add(errors, Math.abs(Number(sample.timing.combined.cpuMs) - expected) <= 1, "combined CPU must equal prewarm CPU plus exact-command CPU");
	}
	add(errors, sample.ensureDist?.observed === true, "ensure-dist accounting is required");
	add(errors, sample.ensureDist?.distState === sample.distState, "ensure-dist state must match sample state");
	add(errors, sample.bundle?.observed === true, "bundle accounting is required");
	for (const group of REQUIRED_GROUPS) {
		const row = sample.groups?.[group];
		add(errors, object(row), `sample.groups.${group} is required`);
		add(errors, finite(row?.wallMs), `sample.groups.${group}.wallMs is required`);
		add(errors, finite(row?.cpuMs), `sample.groups.${group}.cpuMs is required`);
	}
	add(errors, object(sample.discovery?.counts), "discovery counts are required");
	add(errors, Array.isArray(sample.discovery?.manualExcluded), "manual discovery inventory is required");
	add(errors, Number(sample.results?.failures) === 0, "sample must have zero failures");
	add(errors, Number(sample.results?.retries) === 0, "sample must have zero retries");
	add(errors, Number(sample.results?.firstAttemptFailures) === 0, "sample must have zero first-attempt failures");
	add(errors, Number(sample.exit?.code) === 0 && sample.exit?.signal == null, "sample command must exit cleanly");
	add(errors, sample.leaks?.detected === false, "sample must report no leaks");
	add(errors, ["available", "daemon-unavailable", "image-unavailable"].includes(sample.docker?.capability), "Docker capability is required");
	if (sample.docker?.capability === "available") {
		add(errors, typeof sample.docker.imageId === "string" && sample.docker.imageId.length > 0, "Docker image ID is required when available");
		add(errors, typeof sample.docker.imageDigest === "string" && sample.docker.imageDigest.length > 0, "Docker image digest is required when available");
	}
	add(errors, object(sample.install), "lock/ci installer accounting is required");
	add(errors, sample.caps?.A === 2 && sample.caps?.D === 1, "A/D worker caps changed");
	add(errors, sample.caps?.C === 2, "C worker cap changed");
	add(errors, sample.caps?.B === (sample.platform === "win32" ? 1 : 2), "B worker cap changed");

	add(errors, Array.isArray(sample.profileRefs) && sample.profileRefs.length === 2, "exactly two B/C profile references are required");
	const referencedGroups = new Set();
	for (const reference of sample.profileRefs ?? []) {
		add(errors, reference?.group === "B" || reference?.group === "C", "profile reference group must be B or C");
		add(errors, reference?.missing === false, "profile reference must be finalized and present");
		add(errors, Number(reference?.incompleteProcesses) === 0, "profile reference child-process telemetry is incomplete");
		add(errors, Number(reference?.incompleteHookOwners) === 0, "profile reference gateway hook telemetry is incomplete");
		add(errors, Number(reference?.hookRecords) > 0, "profile reference gateway hook records are required");
		if (reference?.group) referencedGroups.add(reference.group);
		add(errors, typeof reference?.path === "string" && reference.path.length > 0, "profile reference path is required");
		if (loadProfile && reference?.path) {
			try {
				const profile = loadProfile(reference.path);
				for (const error of validateE2EProfileManifest(profile, {
					group: reference.group,
					sha: sample.sha,
					distState: sample.distState,
					platform: sample.platform,
				})) errors.push(`${reference.path}: ${error}`);
				add(errors, Number(profile.counts?.retries) === 0, `${reference.path}: qualification profile contains retries`);
				add(errors, Number(profile.counts?.failures) === 0, `${reference.path}: qualification profile contains failures`);
			} catch (error) {
				errors.push(`cannot read profile ${reference.path}: ${error.message}`);
			}
		}
	}
	for (const group of ["B", "C"]) add(errors, referencedGroups.has(group), `profile reference ${group} is required`);
	return errors;
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function validateE2EQualificationAggregate(aggregate, { loadSample, loadProfile } = {}) {
	const errors = [];
	add(errors, aggregate?.schema === E2E_QUALIFICATION_SCHEMA, `qualification.schema must be ${E2E_QUALIFICATION_SCHEMA}`);
	add(errors, aggregate?.kind === "e2e-qualification", "qualification.kind must be e2e-qualification");
	add(errors, aggregate?.productBaselineSha === PRODUCT_BASELINE_SHA, `qualification baseline must be ${PRODUCT_BASELINE_SHA}`);
	add(errors, sha(aggregate?.candidateSha), "qualification.candidateSha must be a full Git SHA");
	add(errors, Array.isArray(aggregate?.samples), "qualification.samples is required");
	const loaded = [];
	for (const entry of aggregate?.samples ?? []) {
		try {
			const sample = typeof entry === "string" ? loadSample?.(entry) : entry;
			if (!sample) throw new Error("sample loader returned no manifest");
			loaded.push(sample);
			for (const error of validateE2ESampleManifest(sample, { loadProfile })) errors.push(`${typeof entry === "string" ? entry : "inline sample"}: ${error}`);
		} catch (error) {
			errors.push(`cannot read sample ${String(entry)}: ${error.message}`);
		}
	}
	for (const platform of REQUIRED_PLATFORMS) for (const state of REQUIRED_STATES) {
		const bucket = loaded.filter((sample) => sample.platform === platform && sample.distState === state);
		const baseline = bucket.filter((sample) => sample.variant === "baseline");
		const candidate = bucket.filter((sample) => sample.variant === "candidate");
		add(errors, baseline.length >= 3, `${platform}/${state} requires at least three baseline samples`);
		add(errors, candidate.length >= 3, `${platform}/${state} requires at least three candidate samples`);
		if (baseline.length >= 3 && candidate.length >= 3) {
			const pairs = new Map();
			for (const sample of bucket) {
				const rows = pairs.get(sample.pair?.id) ?? [];
				rows.push(sample);
				pairs.set(sample.pair?.id, rows);
			}
			add(errors, pairs.size >= 3, `${platform}/${state} requires at least three distinct pairs`);
			add(errors, new Set(bucket.map((sample) => JSON.stringify(sample.discovery))).size === 1, `${platform}/${state} discovery/manual inventory differs`);
			add(errors, new Set(bucket.map((sample) => JSON.stringify({
				capability: sample.docker?.capability,
				imageId: sample.docker?.imageId,
				imageDigest: sample.docker?.imageDigest,
				gatedTests: sample.docker?.gatedTests,
			}))).size === 1, `${platform}/${state} Docker capability/image evidence differs`);
			add(errors, new Set(bucket.map((sample) => JSON.stringify(sample.caps))).size === 1, `${platform}/${state} capacity differs`);
			for (const [pairId, pair] of pairs) {
				add(errors, pair.length === 2, `${platform}/${state}/${pairId} must contain exactly two samples`);
				add(errors, new Set(pair.map((sample) => sample.variant)).size === 2, `${platform}/${state}/${pairId} must pair baseline and candidate`);
				add(errors, new Set(pair.map((sample) => sample.setupFingerprint)).size === 1, `${platform}/${state}/${pairId} setup fingerprints differ`);
				const ordered = [...pair].sort((a, b) => Number(a.pair?.position ?? 99) - Number(b.pair?.position ?? 99));
				const pairIndex = ordered[0]?.pair?.index;
				add(errors, ordered.every((sample) => sample.pair?.index === pairIndex), `${platform}/${state}/${pairId} pair indexes differ`);
				const expectedFirst = pairIndex % 2 === 0 ? "candidate" : "baseline";
				add(errors, ordered[0]?.variant === expectedFirst && ordered[1]?.variant !== expectedFirst, `${platform}/${state}/${pairId} does not follow alternating order`);
			}
			for (const sample of candidate) {
				add(errors, sample.sha === aggregate.candidateSha, `${platform}/${state} candidate SHA mismatch`);
				add(errors, Number(sample.timing.combined.wallMs) < 300_000, `${platform}/${state} candidate combined wall is not under 300s`);
				add(errors, Number(sample.timing.exactCommand.wallMs) < 300_000, `${platform}/${state} candidate command wall is not under 300s`);
			}
			add(errors,
				median(candidate.map((sample) => Number(sample.timing.combined.cpuMs))) <= median(baseline.map((sample) => Number(sample.timing.combined.cpuMs))),
				`${platform}/${state} candidate combined median CPU increased`,
			);
			add(errors,
				median(candidate.map((sample) => Number(sample.timing.exactCommand.cpuMs))) <= median(baseline.map((sample) => Number(sample.timing.exactCommand.cpuMs))),
				`${platform}/${state} candidate command median CPU increased`,
			);
		}
	}
	add(errors, Array.isArray(aggregate?.validationCommands) && aggregate.validationCommands.length > 0, "validation command evidence is required");
	const validationNames = new Set((aggregate?.validationCommands ?? []).map((command) => command.name));
	for (const name of REQUIRED_VALIDATIONS) add(errors, validationNames.has(name), `validation command ${name} is required`);
	for (const [index, command] of (aggregate?.validationCommands ?? []).entries()) {
		add(errors, typeof command.argv === "string" && command.argv.length > 0, `validationCommands[${index}].argv is required`);
		add(errors, command.sha === aggregate.candidateSha, `validationCommands[${index}] SHA mismatch`);
		add(errors, command.exitCode === 0, `validationCommands[${index}] did not pass`);
	}
	return errors;
}

export function readQualificationFile(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
	const path = process.argv[2];
	if (!path) throw new Error("usage: e2e-qualification-manifest.mjs <qualification.json>");
	const absolute = resolve(path);
	const base = dirname(absolute);
	const load = (reference) => readQualificationFile(isAbsolute(reference) ? reference : resolve(base, reference));
	const errors = validateE2EQualificationAggregate(readQualificationFile(absolute), { loadSample: load, loadProfile: load });
	if (errors.length > 0) {
		for (const error of errors) console.error(`[e2e-qualification] ${error}`);
		process.exit(1);
	}
	console.log(`[e2e-qualification] PASS ${absolute}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	try { main(); } catch (error) { console.error(`[e2e-qualification] fatal: ${error.message}`); process.exit(1); }
}
