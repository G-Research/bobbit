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
		const containerPath = '/home/node/.pi/agent/sessions/--workspace--/abc.jsonl';
		const hostPath = containerToHostSessionPath(containerPath, TEST_HOME);
		// Should NOT start with /home/node (the container home)
		assert.ok(!hostPath.startsWith('/home/node'), `should not start with container home, got: ${hostPath}`);
		// Should start with the test homedir
		assert.ok(hostPath.startsWith(TEST_HOME), `should start with host homedir, got: ${hostPath}`);
		// Should end with the relative portion
		assert.ok(
			hostPath.includes('.pi') && hostPath.includes('agent') && hostPath.includes('abc.jsonl'),
			`should contain .pi/agent path components, got: ${hostPath}`,
		);
	});

	it('should remap host path back to container path', () => {
		const containerPath = '/home/node/.pi/agent/sessions/--workspace--/abc.jsonl';
		const hostPath = containerToHostSessionPath(containerPath, TEST_HOME);
		const roundTripped = hostToContainerSessionPath(hostPath, TEST_HOME);
		assert.strictEqual(roundTripped, containerPath);
	});

	it('should not remap non-container paths', () => {
		const normalPath = '/some/other/path/file.jsonl';
		const result = containerToHostSessionPath(normalPath, TEST_HOME);
		assert.strictEqual(result, normalPath, 'non-container paths should pass through unchanged');
	});

	it('should export CONTAINER_AGENT_DIR constant', () => {
		assert.strictEqual(CONTAINER_AGENT_DIR, '/home/node/.pi/agent/');
	});
});
