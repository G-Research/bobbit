import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isMissingRemoteRefDeleteError } from "../src/server/server.ts";

describe("quiet archive remote branch cleanup", () => {
	it("classifies missing remote-ref delete errors from stderr, message, and strings", () => {
		assert.equal(
			isMissingRemoteRefDeleteError({ stderr: "error: remote ref does not exist\nerror: failed to push some refs" }),
			true,
		);
		assert.equal(
			isMissingRemoteRefDeleteError({ message: "error: unable to delete 'goal/abc': remote ref does not exist" }),
			true,
		);
		assert.equal(
			isMissingRemoteRefDeleteError("ERROR: UNABLE TO DELETE 'goal/abc': REMOTE REF DOES NOT EXIST"),
			true,
		);
	});

	it("does not classify real remote delete failures as missing refs", () => {
		const realFailures: unknown[] = [
			{ stderr: "fatal: Authentication failed for 'https://github.com/acme/repo.git/'" },
			{ stderr: "remote: Permission to acme/repo.git denied to user." },
			{ message: "fatal: unable to access 'https://github.com/acme/repo.git/': Could not resolve host: github.com" },
			{ message: "Command failed: git push origin --delete goal/abc\nspawn git ETIMEDOUT" },
			new Error("fatal: the remote end hung up unexpectedly"),
			"error: failed to push some refs to 'origin'",
		];

		for (const failure of realFailures) {
			assert.equal(isMissingRemoteRefDeleteError(failure), false, String(failure));
		}
	});
});
