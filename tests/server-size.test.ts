/**
 * Pin: src/server/server.ts size budget after the routes split.
 *
 * Initial design target was ≤ 1500 lines. The split is partial — server.ts
 * still hosts handleApiRoute() and a number of legacy branches pending
 * migration. The bar below is the current ratchet: it must not regress.
 *
 * As more domains migrate, lower the limit in this file in the same commit.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverFile = path.join(repoRoot, "src", "server", "server.ts");

const LIMIT = 1500; // design-doc §10 target.

describe("server.ts size budget", () => {
	it(`src/server/server.ts ≤ ${LIMIT} lines`, () => {
		const text = fs.readFileSync(serverFile, "utf-8");
		const lines = text.split("\n").length;
		assert.ok(
			lines <= LIMIT,
			`src/server/server.ts has grown to ${lines} lines (limit ${LIMIT}). ` +
			`Migrate more routes out of handleApiRoute() — see docs/design/server-routes-split.md.`,
		);
	});
});
