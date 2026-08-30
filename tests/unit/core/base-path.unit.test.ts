import assert from "node:assert/strict";
import { describe, expectTypeOf, it } from "vitest";

import {
	InvalidBasePathError,
	gatewayRoute,
	normalizeBasePath,
	stripBasePath,
	withBasePath,
	type GatewayRoute,
	type PublicGatewayPath,
} from "../../../src/shared/base-path.ts";

describe("base-path normalization", () => {
	it.each([
		[undefined, ""],
		[null, ""],
		["", ""],
		["   ", ""],
		["/", ""],
		[" / ", ""],
		["bobbit", "/bobbit"],
		["/bobbit/", "/bobbit"],
		["  team/bobbit///  ", "/team/bobbit"],
		["/~user/a_b.c-d", "/~user/a_b.c-d"],
	])("normalizes %j to %j", (raw, expected) => {
		assert.equal(normalizeBasePath(raw), expected);
	});

	it.each([
		"//host",
		"http://host/bobbit",
		"https:host",
		"/a//b",
		"/./x",
		"/../x",
		"/a/./b",
		"/a/../b",
		"/a%2fb",
		"/a%2Fb",
		"/%2e%2e/x",
		"/a?x=1",
		"/a#fragment",
		"/a\\b",
		"/a b",
		"/a:b",
		"/café",
	])("rejects unsafe or ambiguous input %j", (raw) => {
		assert.throws(() => normalizeBasePath(raw), InvalidBasePathError);
	});

	it("rejects every embedded C0 control and DEL", () => {
		for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 0x7f]) {
			const raw = `/a${String.fromCharCode(codePoint)}b`;
			assert.throws(
				() => normalizeBasePath(raw),
				InvalidBasePathError,
				`embedded U+${codePoint.toString(16).padStart(4, "0")} must be rejected`,
			);
		}
	});
});

describe("gateway route branding", () => {
	it.each([
		"/",
		"/api/health",
		"/api/health?full=1",
		"/preview/session/index.html#ready",
	])("accepts internal root-absolute route %j", (raw) => {
		assert.equal(gatewayRoute(raw), raw);
	});

	it.each([
		"",
		"api/health",
		"//host/api/health",
		"https://host/api/health",
		"/api\\health",
	])("rejects non-route input %j", (raw) => {
		assert.throws(() => gatewayRoute(raw), InvalidBasePathError);
	});

	it("rejects every embedded C0 control and DEL in an internal route", () => {
		for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 0x7f]) {
			const raw = `/api/a${String.fromCharCode(codePoint)}b`;
			assert.throws(
				() => gatewayRoute(raw),
				InvalidBasePathError,
				`embedded U+${codePoint.toString(16).padStart(4, "0")} must be rejected`,
			);
		}
	});

	it("keeps internal and public URL shapes opaque at compile time", () => {
		const route = gatewayRoute("/api/health");
		const publicPath = withBasePath(route, "/team/bobbit");
		expectTypeOf(route).toEqualTypeOf<GatewayRoute>();
		expectTypeOf(publicPath).toEqualTypeOf<PublicGatewayPath>();

		const ownershipContract = (_route: GatewayRoute, _publicPath: PublicGatewayPath) => {
			withBasePath(_route, "");
			// @ts-expect-error A mounted public path must not be accepted as an internal route.
			withBasePath(_publicPath, "");
		};
		void ownershipContract;
	});
});

describe("base-path strip and join", () => {
	it("is an identity boundary in root mode", () => {
		assert.equal(stripBasePath("/", ""), "/");
		assert.equal(stripBasePath("/api/health", ""), "/api/health");
		assert.equal(withBasePath(gatewayRoute("/api/health?full=1"), ""), "/api/health?full=1");
	});

	it("strips only exact mounts and segment-boundary descendants", () => {
		assert.equal(stripBasePath("/bobbit", "/bobbit"), "/");
		assert.equal(stripBasePath("/bobbit/", "/bobbit"), "/");
		assert.equal(stripBasePath("/bobbit/api/health", "/bobbit"), "/api/health");
		assert.equal(stripBasePath("/team/bobbit/api/health", "/team/bobbit"), "/api/health");
		assert.equal(stripBasePath("/bobbit-other", "/bobbit"), null);
		assert.equal(stripBasePath("/bobbitish/api/health", "/bobbit"), null);
		assert.equal(stripBasePath("/api/health", "/bobbit"), null);
		assert.equal(stripBasePath("/", "/bobbit"), null);
	});

	it("strips the deployment prefix exactly once", () => {
		assert.equal(stripBasePath("/bobbit/bobbit/api/health", "/bobbit"), "/bobbit/api/health");
	});

	it("joins routes, query strings, and hashes without losing their route shape", () => {
		assert.equal(withBasePath(gatewayRoute("/"), "/bobbit"), "/bobbit/");
		assert.equal(withBasePath(gatewayRoute("/?token=a%2Bb"), "/bobbit"), "/bobbit/?token=a%2Bb");
		assert.equal(withBasePath(gatewayRoute("/session/id#ready"), "/team/bobbit"), "/team/bobbit/session/id#ready");
	});

	it.each(["/api", "/preview", "/ws"])("composes a route below a deployment named %s", (basePath) => {
		assert.equal(
			withBasePath(gatewayRoute("/api/health"), basePath),
			`${basePath}/api/health`,
			"a route that happens to start like the mount is not already public",
		);
	});
});
