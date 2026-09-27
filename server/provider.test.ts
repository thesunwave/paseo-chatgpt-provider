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
    accepting_tasks: true,
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

test("idle session rebinds from finished backend before the next prompt", async () => {
  let workerAFinished = false;
  const submissions: string[] = [];
  const { connection, events } = await connectedProvider(async (request) => {
    if (request.op === "acquire") {
      return session(workerAFinished ? "worker-b" : "worker-a");
    }
    if (request.op === "status") {
      if (request.session_id === "worker-a") {
        return {
          session: workerAFinished
            ? session("worker-a", "/workspace", { state: "finished", live: false, accepting_tasks: false })
            : session("worker-a"),
          tasks: [],
          timeline: [],
        };
      }
      return { session: session("worker-b"), tasks: [], timeline: [] };
    }
    if (request.op === "submit") {
      submissions.push(request.session_id);
      return {
        session_id: request.session_id,
        run_id: request.session_id === "worker-a" ? "run-a" : "run-b",
        state: "queued",
      };
    }
    if (request.op === "wait") {
      return { state: "succeeded", result: request.run_id === "run-a" ? "FIRST" : "SECOND" };
    }
    throw new Error(`unexpected op ${request.op}`);
  });

  await connection.send({
    type: "session.open",
    requestId: "open-rebind-finished",
    sessionId: "provider-session",
    config: { cwd: "/workspace", persist: true },
  });
  await connection.send({
    type: "session.prompt",
    sessionId: "provider-session",
    prompt: {
      clientMessageId: "message-a",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "first" }] },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  workerAFinished = true;
  await connection.send({
    type: "session.prompt",
    sessionId: "provider-session",
    prompt: {
      clientMessageId: "message-b",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "second" }] },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(submissions, ["worker-a", "worker-b"]);
  const persistenceEvents = events.filter((event) => event.type === "session.persistence");
  assert.equal(persistenceEvents.at(-1)?.persistence?.data?.backendSessionId, "worker-b");
  assert.ok(events.some((event) => event.type === "timeline.item" && event.item?.text === "SECOND"));
  await connection.close();
});

test("prompt retries once on a backend that dies between status and submit", async () => {
  let acquireCalls = 0;
  const submissions: string[] = [];
  const { connection, events } = await connectedProvider(async (request) => {
    if (request.op === "acquire") {
      acquireCalls += 1;
      return session(acquireCalls === 1 ? "worker-a" : "worker-b");
    }
    if (request.op === "status") {
      return { session: session(request.session_id), tasks: [], timeline: [] };
    }
    if (request.op === "submit") {
      submissions.push(request.session_id);
      if (request.session_id === "worker-a") throw unavailable("worker-a died");
      return { session_id: "worker-b", run_id: "run-b", state: "queued" };
    }
    if (request.op === "wait") return { state: "succeeded", result: "RECOVERED" };
    throw new Error(`unexpected op ${request.op}`);
  });

  await connection.send({
    type: "session.open",
    requestId: "open-race",
    sessionId: "provider-session",
    config: { cwd: "/workspace", persist: true },
  });
  await connection.send({
    type: "session.prompt",
    sessionId: "provider-session",
    prompt: {
      clientMessageId: "message-race",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "work" }] },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(submissions, ["worker-a", "worker-b"]);
  assert.ok(events.some((event) => event.type === "timeline.item" && event.item?.text === "RECOVERED"));
  assert.equal(
    events.filter((event) => event.type === "session.persistence").at(-1)?.persistence?.data?.backendSessionId,
    "worker-b",
  );
  await connection.close();
});

test("failed rebind does not poison the Paseo session", async () => {
  let replacementAvailable = false;
  let acquireCalls = 0;
  const { connection, events } = await connectedProvider(async (request) => {
    if (request.op === "acquire") {
      acquireCalls += 1;
      if (acquireCalls === 1) return session("worker-a");
      if (replacementAvailable) return session("worker-b");
      throw unavailable("no replacement yet");
    }
    if (request.op === "status") {
      if (request.session_id === "worker-a") {
        return {
          session: session("worker-a", "/workspace", { state: "stale", live: false, accepting_tasks: false }),
          tasks: [],
          timeline: [],
        };
      }
      return { session: session("worker-b"), tasks: [], timeline: [] };
    }
    if (request.op === "submit") {
      return { session_id: request.session_id, run_id: "run-b", state: "queued" };
    }
    if (request.op === "wait") return { state: "succeeded", result: "AFTER_RETRY" };
    throw new Error(`unexpected op ${request.op}`);
  }, { acquireRetryMs: 0 });

  await connection.send({
    type: "session.open",
    requestId: "open-no-replacement",
    sessionId: "provider-session",
    config: { cwd: "/workspace", persist: true },
  });

  await connection.send({
    type: "session.prompt",
    sessionId: "provider-session",
    prompt: {
      clientMessageId: "message-no-replacement",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "first try" }] },
    },
  });
  const firstResult = events.find(
    (event) => event.type === "session.prompt_result" && event.clientMessageId === "message-no-replacement",
  );
  assert.equal(firstResult?.result?.type, "failed");
  assert.equal(firstResult?.result?.error?.code, "unavailable");

  replacementAvailable = true;
  await connection.send({
    type: "session.prompt",
    sessionId: "provider-session",
    prompt: {
      clientMessageId: "message-after-replacement",
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text: "second try" }] },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.ok(events.some((event) => event.type === "timeline.item" && event.item?.text === "AFTER_RETRY"));
  assert.equal(
    events.filter((event) => event.type === "session.persistence").at(-1)?.persistence?.data?.backendSessionId,
    "worker-b",
  );
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
    if (request.op === "status") return { session: session("healthy"), tasks: [], timeline: [] };
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
