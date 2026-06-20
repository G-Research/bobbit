import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package.json files array ships runtime asset directories", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(Array.isArray(pkg.files), "files must be an array");
  for (const entry of ["data/", "docker/"]) {
    assert.ok(
      pkg.files.includes(entry),
      `expected ${JSON.stringify(entry)} in files, got: ${JSON.stringify(pkg.files)}`,
    );
  }
});
