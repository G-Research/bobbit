import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBrowserRunEnvironment,
  createBrowserRunPaths,
  playwrightCommandArgs,
  REPO_ROOT,
} from "../../../scripts/testing-v2/run-browser-v2.mjs";

function isChildPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

describe("browser-v2 coordinator wrapper", () => {
  it("allocates distinct owned roots and reports outside the checkout", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-browser-wrapper-"));
    try {
      const first = createBrowserRunPaths(fixtureRoot);
      const second = createBrowserRunPaths(fixtureRoot);
      const canonicalFixtureRoot = realpathSync(fixtureRoot);

      for (const paths of [first, second]) {
        expect(existsSync(paths.root)).toBe(true);
        expect(dirname(paths.root)).toBe(canonicalFixtureRoot);
        expect(isChildPath(paths.root, paths.report)).toBe(true);
        expect(isChildPath(REPO_ROOT, paths.root)).toBe(false);
        expect(isChildPath(REPO_ROOT, paths.report)).toBe(false);
      }
      expect(first.root).not.toBe(second.root);
      expect(first.report).not.toBe(second.report);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("captures the machine ledger before isolating temp state and preserves retry-free qualification", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-browser-environment-"));
    try {
      const hostTemp = join(fixtureRoot, "machine-temp");
      mkdirSync(hostTemp, { recursive: true });
      const paths = createBrowserRunPaths(join(fixtureRoot, "coordinators"));
      const inherited = {
        HOME: join(fixtureRoot, "host-home"),
        TMPDIR: hostTemp,
        PLAYWRIGHT_BROWSERS_PATH: join(fixtureRoot, "browser-registry"),
        BOBBIT_V2_RETRY_FREE: "1",
      };

      const env = createBrowserRunEnvironment(paths, inherited, "linux");
      const expectedLedger = realpathSync(join(hostTemp, "bobbit-test-v2-ledger"));

      expect(env.BOBBIT_V2_LEDGER_DIR).toBe(expectedLedger);
      expect(isChildPath(paths.root, env.BOBBIT_V2_LEDGER_DIR!)).toBe(false);
      expect(env.TMPDIR).toBe(paths.tempDir);
      expect(isChildPath(paths.root, env.TMPDIR!)).toBe(true);
      expect(env.BOBBIT_V2_RUN_ROOT).toBe(paths.root);
      expect(env.BOBBIT_V2_PLAYWRIGHT_REPORT_PATH).toBe(paths.report);
      expect(env.BOBBIT_V2_RETRY_FREE).toBe("1");
      expect(inherited.TMPDIR).toBe(hostTemp);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("forwards every caller Playwright flag without injecting a retry policy", () => {
    const forwarded = ["--grep", "cross-os coordinator", "--retries=0", "--workers=2"];

    expect(playwrightCommandArgs(forwarded)).toEqual([
      join(REPO_ROOT, "node_modules", "playwright", "cli.js"),
      "test",
      "--config", "playwright-v2.config.ts",
      "--project", "browser-v2",
      ...forwarded,
    ]);
  });
});
