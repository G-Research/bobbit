import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
	containerToHostSessionPath,
	hostToContainerSessionPath,
	CONTAINER_AGENT_DIR,
} from '../src/server/agent/rpc-bridge.js';

// Use a synthetic homedir so the test works regardless of environment
// (including inside Docker containers where homedir is /home/node).
const TEST_HOME = '/home/testuser';

describe('sandbox session path remapping', () => {
	it('should remap container path to host path', () => {
		const containerPath = '/home/node/.bobbit/agent/sessions/--workspace--/abc.jsonl';
		const hostPath = containerToHostSessionPath(containerPath, TEST_HOME);
		// Should NOT start with /home/node (the container home)
		assert.ok(!hostPath.startsWith('/home/node'), `should not start with container home, got: ${hostPath}`);
		// Should start with the test homedir
		assert.ok(hostPath.startsWith(TEST_HOME), `should start with host homedir, got: ${hostPath}`);
		// Should end with the relative portion
		assert.ok(
			hostPath.includes('.bobbit') && hostPath.includes('agent') && hostPath.includes('abc.jsonl'),
			`should contain .bobbit/agent path components, got: ${hostPath}`,
		);
	});

	it('should remap host path back to container path', () => {
		const containerPath = '/home/node/.bobbit/agent/sessions/--workspace--/abc.jsonl';
		const hostPath = containerToHostSessionPath(containerPath, TEST_HOME);
		const roundTripped = hostToContainerSessionPath(hostPath, TEST_HOME);
		assert.strictEqual(roundTripped, containerPath);
	});

	it('should produce exact expected host path', () => {
		const containerPath = '/home/node/.bobbit/agent/sessions/--workspace--/abc.jsonl';
		const hostPath = containerToHostSessionPath(containerPath, TEST_HOME);
		assert.strictEqual(hostPath, '/home/testuser/.bobbit/agent/sessions/--workspace--/abc.jsonl');
	});

	it('should not remap non-container paths', () => {
		const normalPath = '/some/other/path/file.jsonl';
		const result = containerToHostSessionPath(normalPath, TEST_HOME);
		assert.strictEqual(result, normalPath, 'non-container paths should pass through unchanged');
	});

	it('should pass through non-matching host paths in hostToContainerSessionPath', () => {
		const otherPath = '/some/random/path.jsonl';
		const result = hostToContainerSessionPath(otherPath, TEST_HOME);
		assert.strictEqual(result, otherPath, 'non-matching host paths should pass through unchanged');
	});

	it('should handle Windows-style backslash paths in hostToContainerSessionPath', () => {
		const winPath = '/home/testuser\\.bobbit\\agent\\sessions\\--workspace--\\abc.jsonl';
		const result = hostToContainerSessionPath(winPath, TEST_HOME);
		assert.strictEqual(result, '/home/node/.bobbit/agent/sessions/--workspace--/abc.jsonl');
	});

	it('should export CONTAINER_AGENT_DIR constant', () => {
		assert.strictEqual(CONTAINER_AGENT_DIR, '/home/node/.bobbit/agent/');
	});

	it('should remap /workspace/C:/... container paths to host paths', () => {
		const containerPath = '/workspace/C:/Users/joe/.pi/agent/sessions/--workspace--/abc.jsonl';
		const hostPath = containerToHostSessionPath(containerPath);
		assert.strictEqual(hostPath, 'C:/Users/joe/.pi/agent/sessions/--workspace--/abc.jsonl');
	});

	it('should remap /workspace/D:/... container paths to host paths', () => {
		const containerPath = '/workspace/D:/Projects/.bobbit/agent/sessions/--ws--/abc.jsonl';
		const hostPath = containerToHostSessionPath(containerPath);
		assert.strictEqual(hostPath, 'D:/Projects/.bobbit/agent/sessions/--ws--/abc.jsonl');
	});

	it('should not remap /workspace/ paths without Windows drive letter', () => {
		const containerPath = '/workspace/some/relative/path.jsonl';
		const result = containerToHostSessionPath(containerPath);
		assert.strictEqual(result, containerPath, 'non-Windows /workspace/ paths should pass through');
	});

	it('should pass through legacy .pi/agent/ host paths unchanged (no longer remapped)', () => {
		const hostPath = '/home/testuser/.pi/agent/sessions/--workspace--/abc.jsonl';
		const result = hostToContainerSessionPath(hostPath, TEST_HOME);
		assert.strictEqual(result, hostPath, 'legacy .pi paths should pass through unchanged');
	});
});
