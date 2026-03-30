import { describe, it } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';

// This import will fail until the implementation adds these exports to rpc-bridge.ts
import {
	containerToHostSessionPath,
	hostToContainerSessionPath,
	CONTAINER_AGENT_DIR,
} from '../src/server/agent/rpc-bridge.js';

describe('sandbox session path remapping', () => {
	it('should remap container path to host path', () => {
		const containerPath = '/home/node/.pi/agent/sessions/--workspace--/abc.jsonl';
		const hostPath = containerToHostSessionPath(containerPath);
		// Should NOT start with /home/node
		assert.ok(!hostPath.startsWith('/home/node'), `should not start with container home, got: ${hostPath}`);
		// Should end with the relative portion
		assert.ok(
			hostPath.includes('.pi') && hostPath.includes('agent') && hostPath.includes('abc.jsonl'),
			`should contain .pi/agent path components, got: ${hostPath}`,
		);
	});

	it('should remap host path back to container path', () => {
		const containerPath = '/home/node/.pi/agent/sessions/--workspace--/abc.jsonl';
		const hostPath = containerToHostSessionPath(containerPath);
		const roundTripped = hostToContainerSessionPath(hostPath);
		assert.strictEqual(roundTripped, containerPath);
	});

	it('should not remap non-container paths', () => {
		const normalPath = '/some/other/path/file.jsonl';
		const result = containerToHostSessionPath(normalPath);
		assert.strictEqual(result, normalPath, 'non-container paths should pass through unchanged');
	});

	it('should export CONTAINER_AGENT_DIR constant', () => {
		assert.strictEqual(CONTAINER_AGENT_DIR, '/home/node/.pi/agent/');
	});
});
