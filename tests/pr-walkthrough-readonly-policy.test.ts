import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateWalkthroughReadonlyCommand, type WalkthroughReadonlyPolicyOptions } from "../src/server/pr-walkthrough/walkthrough-readonly-policy.ts";

const launchedGithubTarget: WalkthroughReadonlyPolicyOptions = {
	githubTarget: { provider: "github", owner: "owner", repo: "repo", number: 123 },
};

function allowed(command: string, options?: WalkthroughReadonlyPolicyOptions): void {
	const decision = evaluateWalkthroughReadonlyCommand(command, options);
	assert.equal(decision.allowed, true, command + " should be allowed");
}

function blocked(command: string, reasonPattern?: RegExp, options?: WalkthroughReadonlyPolicyOptions): void {
	const decision = evaluateWalkthroughReadonlyCommand(command, options);
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
		allowed("gh api repos/owner/repo/pulls/123 --method GET --jq .title");
	});

	it("scopes GitHub reads to the launched PR target when known", () => {
		allowed("gh pr view 123 --json title,body,headRefOid,baseRefOid", launchedGithubTarget);
		allowed("gh pr diff 123 --patch", launchedGithubTarget);
		allowed("gh api repos/owner/repo/pulls/123", launchedGithubTarget);
		allowed("gh api repos/OWNER/Repo/pulls/123/files --paginate", launchedGithubTarget);
		allowed("gh api --method GET repos/owner/repo/pulls/123/commits", launchedGithubTarget);

		blocked("gh pr view 124 --json title", /launched PR #123/, launchedGithubTarget);
		blocked("gh pr diff 124 --patch", /launched PR #123/, launchedGithubTarget);
		blocked("gh pr view --json title", /must explicitly target launched PR #123/, launchedGithubTarget);
		blocked("gh pr view feature-branch --json title", /URL and branch arguments are not allowed/, launchedGithubTarget);
		blocked("gh pr view https://github.com/owner/repo/pull/123 --json title", /URL arguments are not allowed/, launchedGithubTarget);
		blocked("gh pr view 123 --repo owner/repo", /--repo\/-R is not allowed/, launchedGithubTarget);
		blocked("gh pr view 123 -R owner/repo", /--repo\/-R is not allowed/, launchedGithubTarget);
		blocked("gh pr view 123 --hostname github.com", /--hostname is not allowed/, launchedGithubTarget);
		blocked("gh api repos/owner/repo/pulls/124", /may only read repos\/owner\/repo\/pulls\/123/, launchedGithubTarget);
		blocked("gh api repos/other/repo/pulls/123", /may only read repos\/owner\/repo\/pulls\/123/, launchedGithubTarget);
		blocked("gh api repos/owner/other/pulls/123/files", /may only read repos\/owner\/repo\/pulls\/123/, launchedGithubTarget);
		blocked("gh api https://api.github.com/repos/owner/repo/pulls/123", /URL arguments are not allowed/, launchedGithubTarget);
	});

	it("blocks mutating GitHub commands and write-capable API calls", () => {
		blocked("gh pr review 123 --approve", /not a read-only PR command/);
		blocked("gh pr comment 123 --body ok", /not a read-only PR command/);
		blocked("gh pr merge 123", /not a read-only PR command/);
		blocked("gh pr view 123 --hostname github.com", /--hostname is not allowed/);
		blocked("gh api repos/owner/repo/pulls/123 --hostname github.com", /--hostname is not allowed/);
		blocked("gh api --method POST repos/owner/repo/pulls/123/comments", /GET/);
		blocked("gh api repos/owner/repo/pulls/123 --method PATCH -f title=x", /GET/);
		blocked("gh api repos/owner/repo/pulls/123/files -X PATCH", /GET/);
		blocked("gh api repos/owner/repo/pulls/123 -- --method PATCH", /GET/);
		blocked("gh api repos/owner/repo/pulls/123/commits --method=DELETE", /GET/);
		blocked("gh api repos/owner/repo/pulls/123 --field title=x", /request bodies/);
		blocked("gh api repos/owner/repo/pulls/123 --raw-field=title=x", /request bodies/);
		blocked("gh api repos/owner/repo/pulls/123 -Ftitle=x", /request bodies/);
		blocked("gh api repos/owner/repo/pulls/123 --input payload.json", /request bodies/);
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
		blocked("git.cmd status", /executable file extensions|allowlist/);
		blocked("gh.exe pr view 123", /executable file extensions|allowlist/);
		blocked("rg.exe walkthrough src", /executable file extensions|allowlist/);
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
		allowed("ls .github");
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

	it("blocks long-lived follow flags on otherwise read-only commands", () => {
		blocked("tail -f package.json", /indefinitely|follow/);
		blocked("tail --follow package.json", /indefinitely|follow/);
		blocked("tail --follow=name package.json", /indefinitely|follow/);
		blocked("tail -F package.json", /indefinitely|follow/);
		allowed("tail -20 package.json");
	});

	it("blocks recursive root traversal and hidden or ignore override search flags", () => {
		blocked("grep -R token .", /recursive searches from the repository root|current directory/);
		blocked("grep -r token ./", /recursive searches from the repository root|current directory/);
		blocked("grep --recursive -e token .", /recursive searches from the repository root|current directory/);
		blocked("grep -R token", /recursive searches from the repository root|current directory/);
		blocked("find . -name token", /recursive searches from the repository root|current directory/);
		blocked("find ./ -name token", /recursive searches from the repository root|current directory/);
		blocked("find -name token", /recursive searches from the repository root|current directory/);
		blocked("find . -type f -name '*token*'", /recursive searches from the repository root|current directory/);
		blocked("rg token .", /recursive searches from the repository root|current directory/);
		blocked("rg token ./", /recursive searches from the repository root|current directory/);
		blocked("rg token", /recursive searches from the repository root|current directory/);
		blocked("rg --hidden --no-ignore token .", /hidden|ignored|no-ignore/i);
		blocked("rg -uuu token src", /hidden|ignored/i);
		blocked("rg --unrestricted token src", /hidden|ignored/i);
		blocked("rg --follow token src", /hidden|ignored|symlink/i);
		allowed("grep -R token src/server/pr-walkthrough");
		allowed("find src/server/pr-walkthrough -name token");
		allowed("rg token src/server/pr-walkthrough");
		allowed("rg --regexp=token src/server/pr-walkthrough");
		allowed("grep --recursive --regexp=token src/server/pr-walkthrough");
	});

	it("blocks secret and dot-directory reads in file/search commands", () => {
		blocked("cat .bobbit/state/token", /blocked|hidden|credential|token/i);
		blocked("cat .git/config", /blocked|hidden/i);
		blocked("cat .env", /\.env files are blocked/);
		blocked("grep -R token .bobbit", /blocked|hidden/i);
		blocked("find .git -type f", /blocked|hidden/i);
		blocked("ls .ssh", /blocked|hidden/i);
		blocked("sed -n '1,5p' secrets.json", /credential|token/i);
		blocked("head -20 private.pem", /key|certificate/i);
		blocked("tail -20 config/.npmrc", /hidden path|blocked/i);
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
