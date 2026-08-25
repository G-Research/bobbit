import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { isConnectionRefusal } from "../../e2e/_helpers/test-utils/gateway-readiness.js";

function codedError(code: string, message = code): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

describe("gateway readiness transport classification", () => {
	it("recognizes exact connection refusals through fetch causes and aggregate address attempts", () => {
		const refusal = codedError("ECONNREFUSED", "connection refused");
		expect(isConnectionRefusal(refusal)).toBe(true);
		expect(isConnectionRefusal(Object.assign(new TypeError("fetch failed"), { cause: refusal }))).toBe(true);

		const addressAttempts = new AggregateError([
			codedError("ECONNREFUSED", "IPv6 connection refused"),
			Object.assign(new TypeError("address attempt failed"), {
				cause: codedError("ECONNREFUSED", "IPv4 connection refused"),
			}),
		], "all address attempts failed");
		expect(isConnectionRefusal(Object.assign(new TypeError("fetch failed"), {
			cause: addressAttempts,
		}))).toBe(true);

		const crossRealmAggregate = runInNewContext(`new AggregateError([
			Object.assign(new Error("IPv6 connection refused"), { code: "ECONNREFUSED" }),
			Object.assign(new Error("IPv4 connection refused"), { code: "ECONNREFUSED" }),
		], "all address attempts failed")`) as unknown;
		expect(isConnectionRefusal(Object.assign(new TypeError("fetch failed"), {
			cause: crossRealmAggregate,
		}))).toBe(true);
	});

	it("fails closed for messages, other codes, malformed aggregates, and cycles", () => {
		const refusal = codedError("ECONNREFUSED");
		const cyclic = new Error("cyclic wrapper") as Error & { cause?: unknown };
		cyclic.cause = cyclic;

		for (const unexpected of [
			new Error("connect ECONNREFUSED 127.0.0.1"),
			new TypeError("fetch failed"),
			codedError("ECONNRESET", "socket reset"),
			codedError("HPE_INVALID_CONSTANT", "malformed HTTP response"),
			new AggregateError([], "missing address errors"),
			new AggregateError([refusal, codedError("ECONNRESET")], "mixed transport failures"),
			Object.assign(codedError("ECONNRESET"), { cause: refusal }),
			cyclic,
		]) {
			expect(isConnectionRefusal(unexpected)).toBe(false);
		}
	});
});
