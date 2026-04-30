import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package.json files array ships data/ directory", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(Array.isArray(pkg.files), "files must be an array");
  assert.ok(
    pkg.files.includes("data/"),
    `expected "data/" in files, got: ${JSON.stringify(pkg.files)}`,
  );
});
