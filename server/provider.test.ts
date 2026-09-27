import assert from "node:assert/strict";
import test from "node:test";

import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";

import { createChatGptCodexifyProvider } from "./provider.ts";

function unavailable(message = "unavailable") {
  const error = new Error(message) as Error & { code?: string };
  error.code = "unavailable";
  return error;
}

function timedOut(message = "timed out") {
  const error = new Error(message) as Error & { code?: string };
  error.code = "timed_out";
  return error;
}

function session(id: string, workspace = "/workspace", extra: Record<string, unknown> = {}) {
  return {
    session_id: id,
    state: "waiting",
    live: true,
    workspace: { active_root: workspace, managed_worktree: false },
    pending_commands: 0,
    completed_tasks: 0,
    failed_tasks: 0,
    last_activity_at_ms: 1,
    ...extra,
  };
}

async function connectedProvider(controller: (request: any) => Promise<any>, options: Record<string, unknown> = {}) {
  const provider = createChatGptCodexifyProvider({
    controller: controller as any,
    acquireRetryMs: 25,
    acquireRetryIntervalMs: 1,
    ...options,
  });
  const connection = await provider.connect({
    versions: [1],
    capabilities: ["prompt.message", "prompt.steer", "session.persistence"],
  });
  const events: any[] = [];
  connection.onEvent((event: any) => events.push(event));
  return { connection, events };
}

test("catalog retries transient unavailable capacity", async () => {
  let attempts = 0;
  const { connection, events } = await connectedProvider(async (request) => {
    assert.equal(request.op, "acquire");
    attempts += 1;
    if (attempts < 3) throw unavailable();
    return session("healthy");
  });

  await connection.send({ type: "catalog", requestId: "catalog-1", cwd: "/workspace" });

  assert.equal(attempts, 3);
  assert.equal(events.at(-1)?.type, "catalog");
  await connection.close();
});

test("session open fails over from stale persisted worker", async () => {
  const calls: string[] = [];
  const { connection, events } = await connectedProvider(async (request) => {
    calls.push(request.op);
    if (request.op === "status") {
      return { session: session("stale", "/workspace", { state: "stale", live: false }) };
    }
    if (request.op === "acquire") return session("healthy");
    throw new Error(`unexpected op ${request.op}`);
  });

  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "provider-session",
    persistence: { version: 1, data: { backendSessionId: "stale", cwd: "/workspace" } },
    config: { cwd: "/workspace", persist: true },
  });

  assert.deepEqual(calls, ["status", "acquire"]);
  const opened = events.find((event) => event.type === "session.opened");
  assert.equal(opened?.persistence?.data?.backendSessionId, "healthy");
  assert.ok(events.some((event) => event.type === "session.ready"));
  await connection.close();
});

test("restored active run resumes terminal watcher", async () => {
  const { connection, events } = await connectedProvider(async (request) => {
    if (request.op === "status") {
      return { session: session("active", "/workspace", { state: "working", active_run_id: "run-1" }) };
    }
    if (request.op === "wait") {
      assert.equal(request.session_id, "active");
      assert.equal(request.run_id, "run-1");
      return { state: "succeeded", result: "RESTORED_OK" };
    }
    throw new Error(`unexpected op ${request.op}`);
  });

  await connection.send({
    type: "session.open",
    requestId: "open-2",
    sessionId: "provider-session",
    persistence: { version: 1, data: { backendSessionId: "active", cwd: "/workspace" } },
    config: { cwd: "/workspace", persist: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(events.some((event) => event.type === "timeline.item" && event.item?.text === "RESTORED_OK"));
  assert.ok(events.some((event) => event.type === "session.turn" && event.turnId === "run-1" && event.state === "completed"));
  await connection.close();
});

test("active run publishes backend tool timeline as live Paseo tool progress", async () => {
  let waitCalls = 0;
  const toolStarted = {
    at_ms: 1_000,
    kind: "tool_started",
    seq: 7,
    command_seq: 3,
    tool: "exec_command",
    tool_status: "running",
  };
  const toolCompleted = {
    at_ms: 1_250,
    kind: "tool_completed",
    seq: 7,
    command_seq: 3,
    tool: "exec_command",
    tool_status: "succeeded",
    duration_ms: 250,
  };
  const { connection, events } = await connectedProvider(async (request) => {
    if (request.op === "acquire") return session("healthy");
    if (request.op === "submit") return { session_id: "healthy", run_id: "run-3", state: "queued" };
    if (request.op === "wait") {
      waitCalls += 1;
      if (waitCalls === 1) throw timedOut();
      return { state: "succeeded", result: "DONE" };
    }
    if (request.op === "status") {
      return {
        session: session("healthy", "/workspace", { state: "working", active_run_id: "run-3" }),
        tasks: [{ command_seq: 3 }],
        timeline: waitCalls === 1 ? [toolStarted] : [toolStarted, toolCompleted],
      };
    }
    throw new Error(`unexpected op ${request.op}`);
  });

  await connection.send({
    type: "session.open",
    requestId: "open-progress",
    sessionId: "provider-session",
    config: { cwd: "/workspace", persist: true },
  });
  await connection.send({
    type: "session.prompt",
    sessionId: "provider-session",
    prompt: {
      clientMessageId: "message-progress",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "work" }] },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const toolEvents = events.filter((event) => event.type === "timeline.item" && event.item?.type === "tool_call");
  for (const event of toolEvents) ProviderEventSchema.parse(event);
  assert.deepEqual(toolEvents.map((event) => event.item.status), ["running", "completed"]);
  assert.equal(toolEvents[0]?.item.id, toolEvents[1]?.item.id);
  assert.equal(toolEvents[0]?.item.callId, toolEvents[1]?.item.callId);
  assert.equal(toolEvents[0]?.item.name, "exec_command");
  assert.equal(toolEvents[1]?.item.metadata?.durationMs, 250);
  assert.equal(toolEvents[1]?.timestamp, new Date(1_250).toISOString());
  assert.ok(events.some((event) => event.type === "timeline.item" && event.item?.text === "DONE"));
  assert.ok(events.some((event) => event.type === "session.turn" && event.turnId === "run-3" && event.state === "completed"));
  await connection.close();
});

test("interrupt is acknowledged before backend terminalization", async () => {
  let resolveWait!: (value: any) => void;
  const waitPromise = new Promise<any>((resolve) => {
    resolveWait = resolve;
  });
  const { connection, events } = await connectedProvider(async (request) => {
    if (request.op === "acquire") return session("healthy");
    if (request.op === "submit") return { session_id: "healthy", run_id: "run-2", state: "queued" };
    if (request.op === "wait") return await waitPromise;
    if (request.op === "cancel") return { accepted: true, action: "cancel" };
    if (request.op === "abandon") return { accepted: true, action: "abandon" };
    throw new Error(`unexpected op ${request.op}`);
  });

  await connection.send({
    type: "session.open",
    requestId: "open-3",
    sessionId: "provider-session",
    config: { cwd: "/workspace", persist: true },
  });
  await connection.send({
    type: "session.prompt",
    sessionId: "provider-session",
    prompt: {
      clientMessageId: "message-1",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "work" }] },
    },
  });

  await connection.send({ type: "session.interrupt", requestId: "interrupt-1", sessionId: "provider-session" });
  assert.ok(events.some((event) => event.type === "request.completed" && event.requestId === "interrupt-1"));
  assert.ok(!events.some((event) => event.type === "session.turn" && event.state === "canceled"));

  resolveWait({ state: "cancelled", error: "Interrupted by Paseo" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(events.some((event) => event.type === "session.turn" && event.state === "canceled"));
  await connection.close();
});
