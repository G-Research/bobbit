import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateWalkthroughReadonlyCommand } from "../src/server/pr-walkthrough/walkthrough-readonly-policy.ts";

function allowed(command: string): void {
	const decision = evaluateWalkthroughReadonlyCommand(command);
	assert.equal(decision.allowed, true, command + " should be allowed");
}

function blocked(command: string, reasonPattern?: RegExp): void {
	const decision = evaluateWalkthroughReadonlyCommand(command);
	assert.equal(decision.allowed, false, command + " should be blocked");
	if (!decision.allowed && reasonPattern) assert.match(decision.reason, reasonPattern);
}

describe("PR walkthrough readonly command policy", () => {
	it("allows read-only GitHub PR commands", () => {
		allowed("gh pr view 123 --json title,body,headRefOid,baseRefOid");
		allowed("gh pr diff 123 --patch");
		allowed("gh api repos/owner/repo/pulls/123");
		allowed("gh api repos/owner/repo/pulls/123/files --paginate");
		allowed("gh api --method GET repos/owner/repo/pulls/123/commits");
	});

	it("blocks mutating GitHub commands and write-capable API calls", () => {
		blocked("gh pr review 123 --approve", /not a read-only PR command/);
		blocked("gh pr comment 123 --body ok", /not a read-only PR command/);
		blocked("gh pr merge 123", /not a read-only PR command/);
		blocked("gh api --method POST repos/owner/repo/pulls/123/comments", /GET/);
		blocked("gh api repos/owner/repo/issues/123/comments", /pull request metadata/);
	});

	it("allows read-only git commands", () => {
		allowed("git diff origin/master...HEAD");
		allowed("git show --stat HEAD");
		allowed("git log --oneline -5");
		allowed("git log -1 --format=%H");
		allowed("git rev-parse HEAD");
		allowed("git status --short");
		allowed("git status --porcelain=v2 --branch");
	});

	it("blocks path-qualified executables before command allowlisting", () => {
		blocked("./git status", /path-qualified executables/);
		blocked("../git status", /path-qualified executables/);
		blocked("subdir/git status", /path-qualified executables/);
		blocked(String.raw`.\git status`, /path-qualified executables/);
		blocked(String.raw`C:\tmp\git.exe status`, /path-qualified executables/);
		blocked("tools/rg walkthrough src/server", /path-qualified executables/);
		blocked(String.raw`tools\rg walkthrough src/server`, /path-qualified executables/);
	});

	it("blocks mutating git commands and git filesystem escape flags", () => {
		blocked("git checkout master", /not allowed/);
		blocked("git switch feature", /not allowed/);
		blocked("git reset --hard", /not allowed/);
		blocked("git add src/file.ts", /not allowed/);
		blocked("git commit -m nope", /not allowed/);
		blocked("git push", /not allowed/);
		blocked("git rebase origin/master", /not allowed/);
		blocked("git status --ignored=matching", /restricted/);
		blocked("git -C /tmp diff", /-C|absolute paths/);
		blocked("git --git-dir .git diff", /--git-dir/);
		blocked("git --git-dir=.git diff", /--git-dir/);
		blocked("git --work-tree .. diff", /--work-tree|parent-directory/);
		blocked("git --work-tree=.. diff", /--work-tree|parent-directory/);
		blocked("git diff --output=diff.patch", /--output/);
		blocked("git diff -- src/../package.json", /parent-directory/);
		blocked("git show HEAD -- ':(top)package.json'", /pathspec magic/);
	});

	it("allows read/search commands and bounded sed", () => {
		allowed("rg submit_pr_walkthrough_yaml src/server");
		allowed("rg docker docs");
		allowed("grep -R walkthrough src/server/pr-walkthrough");
		allowed("find src/server/pr-walkthrough -name '*.ts'");
		allowed("ls src/server/pr-walkthrough");
		allowed("cat package.json");
		allowed("sed -n '1,40p' docs/design/pr-walkthrough-agent-session.md");
		allowed("head -20 package.json");
		allowed("tail -20 package.json");
		allowed("pwd");
	});

	it("blocks filesystem escapes, writes, env expansion, and shell metacharacter bypasses", () => {
		blocked("git log -1 --format=$OPENAI_API_KEY", /environment-variable expansion/);
		blocked("git log -1 --format=%SECRET%", /environment-variable expansion/);
		blocked("gh pr view 123 --json $OPENAI_API_KEY", /environment-variable expansion/);
		blocked("rg token %SECRET% src", /environment-variable expansion/);
		blocked("cat /etc/passwd", /absolute paths/);
		blocked(String.raw`cat C:\Windows\win.ini`, /absolute paths/);
		blocked("cat C:/Windows/win.ini", /absolute paths/);
		blocked(String.raw`cat \\server\share\secret`, /absolute paths/);
		blocked("cat ../package.json", /parent-directory/);
		blocked(String.raw`cat ..\package.json`, /parent-directory/);
		blocked(String.raw`cat src\..\secret`, /parent-directory/);
		blocked("cat ~/secret", /home-directory/);
		blocked("cat $HOME/.ssh/config", /environment-variable/);
		blocked("find .. -name '*.ts'", /parent-directory/);
		blocked("rg foo --output out.txt", /--output/);
		blocked("echo hi > file.txt", /redirection/);
		blocked("cat package.json | tee copy.json", /pipes/);
		blocked("rg foo src && npm test", /chaining/);
		blocked("cat <<EOF", /redirection/);
		blocked("rm -rf src", /rm is not permitted/);
		blocked("mkdir tmp", /mkdir is not permitted/);
		blocked("touch src/new.ts", /touch is not permitted/);
		blocked("find . -name '*.tmp' -delete", /find action -delete/);
		blocked("sed -i 's/a/b/' file.ts", /in-place/);
	});

	it("blocks installs, builds, tests, servers, docker, and inline interpreters", () => {
		blocked("npm install", /npm is not permitted/);
		blocked("npm run build", /npm is not permitted/);
		blocked("npm test", /npm is not permitted/);
		blocked("pnpm test", /pnpm is not permitted/);
		blocked("yarn install", /yarn is not permitted/);
		blocked("bun test", /bun is not permitted/);
		blocked("cargo test", /cargo is not permitted/);
		blocked("go test ./...", /go is not permitted/);
		blocked("pytest", /pytest is not permitted/);
		blocked("docker ps", /docker is not permitted/);
		blocked("node -e \"console.log(1)\"", /node is not permitted/);
		blocked("python -c \"print(1)\"", /python is not permitted/);
		blocked("vite --host 0.0.0.0", /vite is not permitted/);
	});
});
