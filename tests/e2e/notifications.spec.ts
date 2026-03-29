/**
 * E2E tests for task notification events over WebSocket.
 *
 * Verifies that `task_changed` WS events are broadcast to connected clients
 * when tasks are created and updated via WS commands.
 */
import { test, expect } from "./gateway-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	connectWs,
	WsConnection,
} from "./e2e-setup.js";

let goalId: string;
let sessionId: string;
let wsConn: WsConnection;

test.beforeAll(async () => {
	// Create a goal (no workflow, no worktree — lightweight)
	const goal = await createGoal({ title: "Notifications E2E test goal" });
	goalId = goal.id;

	// Create a session linked to this goal
	sessionId = await createSession({ goalId });

	// Connect WebSocket to the session
	wsConn = await connectWs(sessionId);
});

test.afterAll(async () => {
	wsConn?.close();
	await deleteSession(sessionId).catch(() => {});
	await deleteGoal(goalId).catch(() => {});
});

test.describe("task_changed WS notifications", () => {
	let taskId: string;

	test("task_create via WS broadcasts task_changed event", async () => {
		// Send a task_create command over WebSocket
		wsConn.send({
			type: "task_create",
			goalId,
			title: "Test notification task",
			taskType: "implementation",
			spec: "A task to test notifications",
		});

		// Wait for the task_changed event
		const msg = await wsConn.waitFor(
			(m) => m.type === "task_changed" && m.task?.title === "Test notification task",
			5000,
		);

		expect(msg.type).toBe("task_changed");
		expect(msg.task).toBeDefined();
		expect(msg.task.title).toBe("Test notification task");
		expect(msg.task.type).toBe("implementation");
		expect(msg.task.state).toBe("todo");
		expect(msg.task.goalId).toBe(goalId);
		expect(typeof msg.task.id).toBe("string");

		// Save the task ID for subsequent tests
		taskId = msg.task.id;
	});

	test("task_update state to in-progress broadcasts task_changed event", async () => {
		expect(taskId).toBeDefined();

		// Clear previously received messages for clean waiting
		const prevCount = wsConn.messages.length;

		// Update task state to in-progress via WS
		wsConn.send({
			type: "task_update",
			taskId,
			updates: { state: "in-progress" },
		});

		// Wait for the task_changed event with in-progress state
		const msg = await wsConn.waitFor(
			(m) =>
				m.type === "task_changed" &&
				m.task?.id === taskId &&
				m.task?.state === "in-progress",
			5000,
		);

		expect(msg.type).toBe("task_changed");
		expect(msg.task.id).toBe(taskId);
		expect(msg.task.state).toBe("in-progress");
		expect(msg.task.title).toBe("Test notification task");
	});

	test("task_update state to complete broadcasts task_changed event", async () => {
		expect(taskId).toBeDefined();

		// Update task state to complete via WS
		wsConn.send({
			type: "task_update",
			taskId,
			updates: { state: "complete" },
		});

		// Wait for the task_changed event with complete state
		const msg = await wsConn.waitFor(
			(m) =>
				m.type === "task_changed" &&
				m.task?.id === taskId &&
				m.task?.state === "complete",
			5000,
		);

		expect(msg.type).toBe("task_changed");
		expect(msg.task.id).toBe(taskId);
		expect(msg.task.state).toBe("complete");
	});

	test("task_update with spec change broadcasts task_changed event", async () => {
		// Create a second task for this test
		wsConn.send({
			type: "task_create",
			goalId,
			title: "Spec update task",
			taskType: "testing",
		});

		const createMsg = await wsConn.waitFor(
			(m) => m.type === "task_changed" && m.task?.title === "Spec update task",
			5000,
		);
		const task2Id = createMsg.task.id;

		// Update just the spec
		wsConn.send({
			type: "task_update",
			taskId: task2Id,
			updates: { spec: "Updated spec content" },
		});

		const updateMsg = await wsConn.waitFor(
			(m) =>
				m.type === "task_changed" &&
				m.task?.id === task2Id &&
				m.task?.spec === "Updated spec content",
			5000,
		);

		expect(updateMsg.task.spec).toBe("Updated spec content");
		expect(updateMsg.task.state).toBe("todo"); // unchanged
	});

	test("task_delete broadcasts task_changed event with _deleted flag", async () => {
		// Create a task to delete
		wsConn.send({
			type: "task_create",
			goalId,
			title: "Task to delete",
			taskType: "custom",
		});

		const createMsg = await wsConn.waitFor(
			(m) => m.type === "task_changed" && m.task?.title === "Task to delete",
			5000,
		);
		const deleteTaskId = createMsg.task.id;

		// Delete it
		wsConn.send({
			type: "task_delete",
			taskId: deleteTaskId,
		});

		const deleteMsg = await wsConn.waitFor(
			(m) =>
				m.type === "task_changed" &&
				m.task?.id === deleteTaskId &&
				m.task?._deleted === true,
			5000,
		);

		expect(deleteMsg.task._deleted).toBe(true);
		expect(deleteMsg.task.id).toBe(deleteTaskId);
	});

	test("task_update for nonexistent task returns error", async () => {
		wsConn.send({
			type: "task_update",
			taskId: "nonexistent-task-id-12345",
			updates: { state: "in-progress" },
		});

		const errMsg = await wsConn.waitFor(
			(m) => m.type === "error" && m.code === "TASK_NOT_FOUND",
			5000,
		);

		expect(errMsg.type).toBe("error");
		expect(errMsg.code).toBe("TASK_NOT_FOUND");
	});
});
