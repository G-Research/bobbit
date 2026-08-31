import { describe, expect, it } from "vitest";
import {
	hasTag,
	isPinned,
	isSessionArchived,
	isSessionBusy,
	isSessionReadFilterable,
	normalizeTags,
	projectServerTags,
	removeTag,
	replaceTag,
	sessionShowsLastActivity,
	sessionTeamKind,
} from "../../../src/shared/session-tags.js";

describe("session tag normalization", () => {
	it("reads legacy missing and malformed containers as empty arrays", () => {
		expect(normalizeTags(undefined)).toEqual([]);
		expect(normalizeTags(null)).toEqual([]);
		expect(normalizeTags("pinned=true")).toEqual([]);
		expect(normalizeTags({ pinned: true })).toEqual([]);
	});

	it("keeps valid opaque values and removes malformed entries", () => {
		expect(normalizeTags([
			"project-id=project/alpha",
			"future-key=value=with=equals",
			"UPPER=value",
			"bad_key=value",
			"-bad=value",
			"missing-equals",
			"empty=",
			42,
			null,
		])).toEqual([
			"project-id=project/alpha",
			"future-key=value=with=equals",
		]);
	});

	it("uses the last valid occurrence per key with deterministic survivor order", () => {
		expect(normalizeTags([
			"alpha=first",
			"beta=only",
			"alpha=last",
			"beta=only",
			"gamma=final",
		])).toEqual([
			"alpha=last",
			"beta=only",
			"gamma=final",
		]);
	});
});

describe("keyed session tag operations", () => {
	it("matches only exact normalized key/value pairs", () => {
		const tags = ["pinned=false", "feature-pinned=true", "pinned=true"];
		expect(hasTag(tags, "pinned", "true")).toBe(true);
		expect(hasTag(tags, "pinned", "false")).toBe(false);
		expect(hasTag(tags, "pin", "true")).toBe(false);
		expect(hasTag(tags, "Pinned", "true")).toBe(false);
	});

	it("replaces conflicting pinned values once and preserves unrelated tags", () => {
		const input = ["owner=alice", "pinned=false", "future-key=opaque", "pinned=legacy"];
		const pinned = replaceTag(input, "pinned", "true");
		expect(pinned).toEqual(["owner=alice", "future-key=opaque", "pinned=true"]);
		expect(replaceTag(pinned, "pinned", "true")).toEqual(pinned);
		expect(isPinned(pinned)).toBe(true);
	});

	it("removes all pinned values without touching unrelated tags", () => {
		const input = ["owner=alice", "pinned=false", "future-key=opaque", "pinned=true"];
		expect(removeTag(input, "pinned")).toEqual(["owner=alice", "future-key=opaque"]);
		expect(isPinned(removeTag(input, "pinned"))).toBe(false);
	});

	it("normalizes input but refuses malformed keyed mutations", () => {
		const input = ["owner=first", "owner=last", "pinned=true"];
		expect(replaceTag(input, "Bad_Key", "value")).toEqual(["owner=last", "pinned=true"]);
		expect(replaceTag(input, "owner", "")).toEqual(["owner=last", "pinned=true"]);
		expect(removeTag(input, "Bad_Key")).toEqual(["owner=last", "pinned=true"]);
	});
});

describe("canonical session tag classifiers", () => {
	it.each([
		["streaming", false, true],
		["aborting", false, true],
		["preparing", false, true],
		["starting", false, true],
		["idle", true, true],
		["idle", false, false],
		["terminated", false, false],
		["busy", false, false],
	] as const)("classifies status=%s compacting=%s as busy=%s", (status, isCompacting, expected) => {
		expect(isSessionBusy({ status, isCompacting })).toBe(expected);
	});

	it.each([
		["streaming", false, false],
		["busy", false, false],
		["idle", true, false],
		["idle", false, true],
		["terminated", false, true],
	] as const)("classifies status=%s compacting=%s as showing last activity=%s", (status, isCompacting, expected) => {
		expect(sessionShowsLastActivity({ status, isCompacting })).toBe(expected);
	});

	it.each([
		["idle", true],
		["terminated", true],
		["archived", false],
		["streaming", false],
		["aborting", false],
		[undefined, false],
	] as const)("classifies status=%s as read-filterable=%s", (status, expected) => {
		expect(isSessionReadFilterable({ status })).toBe(expected);
	});

	it("detects leads and explicit or legacy team members", () => {
		expect(sessionTeamKind({ role: "team-lead", teamLeadSessionId: "malformed" })).toBe("lead");
		expect(sessionTeamKind({ role: "coder", teamLeadSessionId: "lead" })).toBe("member");
		expect(sessionTeamKind({ role: "reviewer", teamGoalId: "goal" })).toBe("member");
		expect(sessionTeamKind({ teamGoalId: "legacy-goal" })).toBe("member");
	});

	it("does not infer team membership from delegate or first-class parentage", () => {
		expect(sessionTeamKind({ role: "coder", goalId: "ordinary-goal" })).toBe("none");
		expect(sessionTeamKind({ role: "coder", goalId: "ordinary-goal", delegateOf: "parent" })).toBe("none");
		expect(sessionTeamKind({ parentSessionId: "parent" })).toBe("none");
	});

	it("classifies only explicit archived records as archived", () => {
		expect(isSessionArchived({ archived: true })).toBe(true);
		expect(isSessionArchived({ archived: false })).toBe(false);
		expect(isSessionArchived({})).toBe(false);
	});
});

describe("server tag projection", () => {
	it("projects the complete canonical tag set in stable order", () => {
		expect(projectServerTags({
			status: "streaming",
			archived: true,
			role: "coder",
			teamGoalId: "goal-1",
			teamLeadSessionId: "lead",
			projectId: "project-1",
		}, { unread: true })).toEqual([
			"read-state=unread",
			"activity-state=busy",
			"archive-state=archived",
			"team-kind=member",
			"project-id=project-1",
			"goal-id=goal-1",
		]);
	});

	it("uses canonical list context over incomplete or stale record fields", () => {
		expect(projectServerTags({
			status: "idle",
			archived: false,
			projectId: "stale-project",
			goalId: "stale-goal",
			role: "team-lead",
		}, {
			unread: false,
			archived: true,
			projectId: "canonical-project",
			goalId: "canonical-goal",
		})).toEqual([
			"read-state=read",
			"activity-state=not-busy",
			"archive-state=archived",
			"team-kind=lead",
			"project-id=canonical-project",
			"goal-id=canonical-goal",
		]);
	});

	it("omits absent project and goal identifiers", () => {
		expect(projectServerTags({ status: "idle" }, { unread: false })).toEqual([
			"read-state=read",
			"activity-state=not-busy",
			"archive-state=live",
			"team-kind=none",
		]);
	});
});
