/**
 * Unit tests for the PR-walkthrough trusted-host allowlist core in
 * `src/shared/pr-walkthrough/url-safety.ts`:
 *   - normalizeTrustedHost / normalizeTrustedHosts (the single save/read normalizer)
 *   - isTrustedExternalHost / safeExternalUrl reading a managed extra-hosts list
 *
 * These replace the removed env-var (`BOBBIT_GITHUB_TRUSTED_HOSTS`) behaviour: the
 * allowlist is now a managed string[] passed in, never read from the environment.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	normalizeTrustedHost,
	normalizeTrustedHosts,
	isTrustedExternalHost,
	safeExternalUrl,
} from "../src/shared/pr-walkthrough/url-safety.ts";

describe("normalizeTrustedHost", () => {
	it("lowercases and strips a trailing dot", () => {
		assert.equal(normalizeTrustedHost("GitHub.Example.com"), "github.example.com");
		assert.equal(normalizeTrustedHost("github.example.com."), "github.example.com");
		assert.equal(normalizeTrustedHost("  ENT.corp  "), "ent.corp");
	});

	it("extracts the host from a pasted URL", () => {
		assert.equal(normalizeTrustedHost("https://ent.corp/some/path?x=1"), "ent.corp");
		assert.equal(normalizeTrustedHost("http://GitHub.example.com/acme/repo/pull/3"), "github.example.com");
	});

	it("rejects junk, paths, ports, credentials and whitespace", () => {
		assert.equal(normalizeTrustedHost("not a host"), undefined);
		assert.equal(normalizeTrustedHost("ent.corp/path"), undefined);
		assert.equal(normalizeTrustedHost("ent.corp:8443"), undefined);
		assert.equal(normalizeTrustedHost("user@ent.corp"), undefined);
		assert.equal(normalizeTrustedHost("ent corp"), undefined);
		assert.equal(normalizeTrustedHost("foo_bar.com"), undefined);
		assert.equal(normalizeTrustedHost(""), undefined);
		assert.equal(normalizeTrustedHost("."), undefined);
		assert.equal(normalizeTrustedHost(42 as unknown), undefined);
		assert.equal(normalizeTrustedHost(null), undefined);
	});

	it("rejects hosts with empty, over-long, or hyphen-edged labels", () => {
		assert.equal(normalizeTrustedHost(".example.com"), undefined);
		assert.equal(normalizeTrustedHost("example.com."), "example.com"); // trailing dot stripped, then valid
		assert.equal(normalizeTrustedHost("example..com"), undefined);
		assert.equal(normalizeTrustedHost("-example.com"), undefined);
		assert.equal(normalizeTrustedHost("example-.com"), undefined);
		assert.equal(normalizeTrustedHost("foo.-bar.com"), undefined);
		assert.equal(normalizeTrustedHost(`${"a".repeat(64)}.com`), undefined);
		assert.equal(normalizeTrustedHost(`${"a".repeat(63)}.com`), `${"a".repeat(63)}.com`);
	});
});

describe("normalizeTrustedHosts", () => {
	it("normalizes an array, dropping invalid and deduping first-seen order", () => {
		const result = normalizeTrustedHosts([
			"GitHub.com",
			"github.example.com.",
			"not a host",
			"https://ent.corp/x",
			"GITHUB.EXAMPLE.COM",
		]);
		// github.com is a DEFAULT baseline host and is filtered from the managed
		// (extra-hosts) list; it stays trusted via isTrustedExternalHost regardless.
		assert.deepEqual(result, ["github.example.com", "ent.corp"]);
	});

	it("filters DEFAULT baseline hosts from the managed list", () => {
		assert.deepEqual(
			normalizeTrustedHosts(["github.com", "www.github.com", "api.github.com", "raw.githubusercontent.com", "ent.corp"]),
			["ent.corp"],
		);
		assert.deepEqual(normalizeTrustedHosts(["GitHub.com", "github.example.com"]), ["github.example.com"]);
	});

	it("accepts a comma-separated string (back-compat parsing)", () => {
		assert.deepEqual(normalizeTrustedHosts("ent.corp, github.example.com ,, bad host"), ["ent.corp", "github.example.com"]);
	});

	it("returns [] for non-array/non-string input", () => {
		assert.deepEqual(normalizeTrustedHosts(undefined), []);
		assert.deepEqual(normalizeTrustedHosts(null), []);
		assert.deepEqual(normalizeTrustedHosts({}), []);
		assert.deepEqual(normalizeTrustedHosts(42), []);
	});
});

describe("isTrustedExternalHost", () => {
	it("always trusts DEFAULT baseline hosts regardless of managed list", () => {
		assert.equal(isTrustedExternalHost("github.com"), true);
		assert.equal(isTrustedExternalHost("api.github.com"), true);
		assert.equal(isTrustedExternalHost("raw.githubusercontent.com", []), true);
	});

	it("trusts a managed extra host and rejects unlisted hosts", () => {
		assert.equal(isTrustedExternalHost("ent.corp", ["ent.corp"]), true);
		assert.equal(isTrustedExternalHost("ENT.corp.", ["ent.corp"]), true);
		assert.equal(isTrustedExternalHost("evil.example", ["ent.corp"]), false);
		assert.equal(isTrustedExternalHost("ent.corp"), false);
	});
});

describe("safeExternalUrl", () => {
	it("permits DEFAULT and managed hosts, rejects untrusted ones", () => {
		assert.equal(safeExternalUrl("https://github.com/acme/repo/pull/1"), "https://github.com/acme/repo/pull/1");
		assert.equal(safeExternalUrl("https://ent.corp/acme/repo/pull/1", ["ent.corp"]), "https://ent.corp/acme/repo/pull/1");
		assert.equal(safeExternalUrl("https://ent.corp/acme/repo/pull/1"), undefined);
		assert.equal(safeExternalUrl("ftp://github.com/x"), undefined);
		assert.equal(safeExternalUrl("not a url"), undefined);
	});
});
