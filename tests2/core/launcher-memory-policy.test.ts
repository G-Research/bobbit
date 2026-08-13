import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shellLauncher = readFileSync(new URL("../../run", import.meta.url), "utf8");
const windowsLauncher = readFileSync(new URL("../../run.cmd", import.meta.url), "utf8");

describe("gateway launcher memory policy", () => {
	it("sets an overridable 8 GiB old-space ceiling before the script on POSIX", () => {
		const launch = shellLauncher.split(/\r?\n/).find(line => line.startsWith("exec node "));
		expect(launch).toBe('exec node "--max-old-space-size=${BOBBIT_MAX_OLD_SPACE_MB:-8192}" "$BOBBIT_HOME/dist/server/cli.js" --cwd "$(pwd)" "$@"');
	});

	it("sets the same default and argument ordering on Windows", () => {
		expect(windowsLauncher).toContain("if not defined BOBBIT_MAX_OLD_SPACE_MB set BOBBIT_MAX_OLD_SPACE_MB=8192");
		const launch = windowsLauncher.split(/\r?\n/).find(line => line.startsWith("node \"--max-old-space-size="));
		expect(launch).toBe('node "--max-old-space-size=%BOBBIT_MAX_OLD_SPACE_MB%" "%BOBBIT_HOME%\\dist\\server\\cli.js" --cwd "%CD%" %*');
	});
});
