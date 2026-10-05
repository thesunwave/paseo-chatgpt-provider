import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const PROVIDER_PROTOCOL_VERSION = 1;
const DEFAULT_SOCKET_PATH = "/Users/Shared/codexify-chatgpt/backend.sock";
const INTERRUPT_GRACE_MS = 20_000;
const ACQUIRE_RETRY_MS = 2_500;
const ACQUIRE_RETRY_INTERVAL_MS = 100;
const PROGRESS_POLL_MS = 500;
const PERSISTENCE_VERSION = 2;
const SUPPORTED_CAPABILITIES = ["prompt.message", "prompt.steer", "session.persistence"] as const;

type JsonRecord = Record<string, unknown>;

type ControllerError = Error & { code?: string };

type ControllerCall = <T = unknown>(request: JsonRecord) => Promise<T>;

type TimelineHistoryEntry = {
  item: any;
  timestamp?: string;
};

export type ChatGptCodexifyProviderOptions = {
  controller?: ControllerCall;
  acquireRetryMs?: number;
  acquireRetryIntervalMs?: number;
};

type SessionState = {
  backendSessionId: string | null;
  cwd: string;
  activeRunId: string | null;
  activeTurnId: string | null;
  closed: boolean;
  persist: boolean;
  timeline: TimelineHistoryEntry[];
};

type ControllerEnvelope<T = unknown> = {
  id?: string;
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
};

function controllerSocketPath(): string {
  return process.env.CODEXIFY_CHATGPT_BACKEND_SOCKET?.trim() || DEFAULT_SOCKET_PATH;
}

async function controller<T>(request: JsonRecord): Promise<T> {
  const id = randomUUID();
  const payload = JSON.stringify({ ...request, id }) + "\n";
  return await new Promise<T>((resolve, reject) => {
    const socket = createConnection({ path: controllerSocketPath() });
    let settled = false;
    let buffer = "";

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(330_000, () => fail(new Error("Codexify backend controller timed out")));
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (settled) return;
      settled = true;
      socket.end();
      try {
        const envelope = JSON.parse(buffer.slice(0, newline)) as ControllerEnvelope<T>;
        if (envelope.id !== id) {
          reject(new Error("Codexify backend controller response id mismatch"));
          return;
        }
        if (!envelope.ok) {
          const error = new Error(envelope.error?.message || "Codexify backend controller failed") as ControllerError;
          error.code = envelope.error?.code;
          reject(error);
          return;
        }
        resolve(envelope.result as T);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", fail);
  });
}


function persistenceHandle(session: SessionState) {
  return {
    version: PERSISTENCE_VERSION,
    data: {
      ...(session.backendSessionId ? { backendSessionId: session.backendSessionId } : {}),
      cwd: session.cwd,
      timeline: session.timeline.map((entry) => ({
        item: entry.item,
        ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      })),
    },
  };
}

function restoredBackendSessionId(persistence: any): string | null {
  if (
    !persistence ||
    ![1, PERSISTENCE_VERSION].includes(persistence.version) ||
    typeof persistence.data !== "object" ||
    persistence.data === null
  ) {
    return null;
  }
  return typeof persistence.data.backendSessionId === "string" ? persistence.data.backendSessionId : null;
}

function restoredTimeline(persistence: any): TimelineHistoryEntry[] {
  if (
    !persistence ||
    persistence.version !== PERSISTENCE_VERSION ||
    typeof persistence.data !== "object" ||
    persistence.data === null ||
    !Array.isArray(persistence.data.timeline)
  ) {
    return [];
  }
  return persistence.data.timeline
    .filter((entry: any) => entry && typeof entry === "object" && entry.item && typeof entry.item === "object")
    .map((entry: any) => ({
      item: entry.item,
      ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
    }));
}

function updateTimelineSnapshot(session: SessionState, item: any, timestamp?: string) {
  const next = {
    item,
    ...(timestamp ? { timestamp } : {}),
  };
  const index = session.timeline.findIndex((entry) => entry.item?.id === item?.id);
  if (index >= 0) {
    session.timeline[index] = next;
  } else {
    session.timeline.push(next);
  }
}

function providerError(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as ControllerError).code;
    return { message: error.message, ...(code ? { code } : {}) };
  }
  return { message: String(error) };
}

function isRecoverableBackendError(error: unknown): boolean {
  const code = (error as ControllerError)?.code;
  return code === "unavailable" || code === "not_found" || code === "busy";
}

function promptText(input: any): string {
  if (input?.type !== "message" || !Array.isArray(input.content)) {
    throw new Error("ChatGPT Codexify provider only supports text message prompts");
  }
  const text = input.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n\n")
    .trim();
  if (!text) throw new Error("ChatGPT Codexify provider received an empty text prompt");
  return text;
}

function isTerminalState(state: string): boolean {
  return ["succeeded", "failed", "cancelled", "stale"].includes(state);
}

function toolCallStatus(entry: any): "running" | "completed" | "failed" | "canceled" | null {
  if (entry?.kind === "tool_started") return "running";
  if (entry?.kind !== "tool_completed") return null;
  switch (entry.tool_status) {
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "canceled";
    default:
      return null;
  }
}

function parsePreview(value: unknown): any {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function previewText(value: any): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const structured = value.structuredContent?.upstream_result ?? value.structuredContent;
  if (typeof structured?.output === "string") return structured.output;
  if (typeof structured?.content === "string") return structured.content;
  if (Array.isArray(value.content)) {
    const text = value.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
    if (text) return text;
  }
  return undefined;
}

function toolResultPayload(value: any): any {
  if (typeof value === "string") {
    const parsed = parsePreview(value);
    return parsed === value ? null : toolResultPayload(parsed);
  }
  if (!value || typeof value !== "object") return null;
  if (value.upstream_result && typeof value.upstream_result === "object") {
    return toolResultPayload(value.upstream_result) ?? value.upstream_result;
  }
  if (value.structuredContent && typeof value.structuredContent === "object") {
    return toolResultPayload(value.structuredContent) ?? value.structuredContent;
  }
  if (
    typeof value.output === "string" ||
    typeof value.exit_code === "number" ||
    typeof value.exitCode === "number" ||
    value.session_id !== undefined ||
    value.sessionId !== undefined
  ) {
    return value;
  }
  if (Array.isArray(value.content)) {
    for (const part of value.content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      const parsed = toolResultPayload(part.text);
      if (parsed) return parsed;
    }
  }
  return null;
}

function normalizedToolResult(entry: any) {
  const response = parsePreview(entry.response_preview);
  const payload = toolResultPayload(response);
  const output =
    typeof payload?.output === "string"
      ? payload.output
      : typeof payload?.content === "string"
        ? payload.content
        : previewText(response);
  const exitCode =
    typeof payload?.exit_code === "number"
      ? payload.exit_code
      : typeof payload?.exitCode === "number"
        ? payload.exitCode
        : undefined;
  const sessionId = payload?.session_id ?? payload?.sessionId;
  return {
    output,
    exitCode,
    sessionId: typeof sessionId === "string" || typeof sessionId === "number" ? sessionId : undefined,
  };
}

function compactShellSummary(command: string): string {
  const line =
    command
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value && !/^set\s+[+-]/.test(value) && !/^[A-Z_][A-Z0-9_]*=/.test(value)) ??
    command.trim().split("\n")[0] ??
    "command";
  return line.length <= 96 ? line : line.slice(0, 93) + "...";
}

function shellDetail(
  command: string,
  cwd: string | undefined,
  output: string | undefined,
  exitCode: number | undefined,
  failed: boolean,
): any {
  if (!command.includes("\n") && command.length <= 120) {
    return {
      type: "shell",
      command,
      ...(cwd ? { cwd } : {}),
      ...(output ? { output } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }
  const body = ["$ " + command, output ? output : null].filter(Boolean).join("\n\n");
  return {
    type: "plain_text",
    label: compactShellSummary(command),
    text: body,
    icon: "square_terminal",
  };
}

function toolCallDetail(tool: string, entry: any): any {
  const input = parsePreview(entry.request_preview);

  if (tool === "exec_command" && input && typeof input === "object" && typeof input.cmd === "string") {
    const result = normalizedToolResult(entry);
    return shellDetail(
      input.cmd,
      typeof input.workdir === "string" && input.workdir ? input.workdir : undefined,
      result.output,
      result.exitCode,
      entry.tool_status === "failed" || (result.exitCode !== undefined && result.exitCode !== 0),
    );
  }

  const response = parsePreview(entry.response_preview);
  if (tool === "read_file" && input && typeof input === "object" && typeof input.path === "string") {
    const content = previewText(response);
    return {
      type: "read",
      filePath: input.path,
      ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      ...(content ? { content } : {}),
    };
  }

  if (tool === "write_file" && input && typeof input === "object" && typeof input.path === "string") {
    return {
      type: "write",
      filePath: input.path,
      ...(typeof input.content === "string" ? { content: input.content } : {}),
    };
  }

  if (tool === "git_status") {
    const text = previewText(response);
    return {
      type: "plain_text",
      label: "Git status",
      ...(text ? { text } : {}),
      icon: "eye",
    };
  }

  const details = [
    typeof entry.request_preview === "string" && entry.request_preview
      ? "Input\n" + entry.request_preview
      : null,
    typeof entry.response_preview === "string" && entry.response_preview
      ? "Output\n" + entry.response_preview
      : null,
  ].filter(Boolean);
  return {
    type: "plain_text",
    label: tool,
    ...(details.length ? { text: details.join("\n\n") } : {}),
    icon: "wrench",
  };
}

function failedToolError(tool: string, entry: any): any {
  const result = normalizedToolResult(entry);
  const message =
    result.exitCode !== undefined
      ? `Process exited with code ${result.exitCode}`
      : result.output?.trim() || `${tool} failed`;
  return { content: message };
}

export function createChatGptCodexifyProvider(options: ChatGptCodexifyProviderOptions = {}) {
  const callController = options.controller ?? controller;
  const acquireRetryMs = options.acquireRetryMs ?? ACQUIRE_RETRY_MS;
  const acquireRetryIntervalMs = options.acquireRetryIntervalMs ?? ACQUIRE_RETRY_INTERVAL_MS;

  return {
    id: "chatgpt-codexify",
    label: "ChatGPT via Codexify",
    description: "Attached ChatGPT coding session routed through Codexify",
    async connect(request: { versions: number[]; capabilities: string[] }) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION)) {
        throw new Error(`Unsupported provider protocol versions: ${request.versions.join(", ")}`);
      }

      const capabilities = SUPPORTED_CAPABILITIES.filter((capability) =>
        request.capabilities.includes(capability),
      );
      const listeners = new Set<(event: any) => void>();
      const sessions = new Map<string, SessionState>();
      const interruptedRunIds = new Set<string>();
      let closed = false;

      const emit = (event: any) => {
        if (closed) return;
        for (const listener of listeners) listener(event);
      };

      const emitPersistence = (providerSessionId: string, session: SessionState) => {
        if (!session.persist) return;
        emit({
          type: "session.persistence",
          sessionId: providerSessionId,
          persistence: persistenceHandle(session),
        });
      };

      const emitTimeline = (
        providerSessionId: string,
        session: SessionState,
        item: any,
        timestamp = new Date().toISOString(),
      ) => {
        updateTimelineSnapshot(session, item, timestamp);
        emit({
          type: "timeline.item",
          sessionId: providerSessionId,
          item,
          timestamp,
        });
        emitPersistence(providerSessionId, session);
      };

      const dispatchAvailableBackend = async (workspace: string, prompt: string) => {
        const deadline = Date.now() + Math.max(0, acquireRetryMs);
        for (;;) {
          try {
            return await callController<any>({
              op: "dispatch",
              workspace,
              rebind: true,
              prompt,
            });
          } catch (error) {
            if ((error as ControllerError)?.code !== "unavailable" || Date.now() >= deadline) {
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.max(1, acquireRetryIntervalMs)));
          }
        }
      };

      const resolveRestoredBackendSession = async (workspace: string, restoredSessionId: string | null) => {
        if (!restoredSessionId) return null;
        try {
          const status = await callController<any>({ op: "status", session_id: restoredSessionId });
          const restored = status?.session;
          if (restored?.workspace?.active_root && restored.workspace.active_root !== workspace) {
            return null;
          }
          return restored?.live ? restored : null;
        } catch (error) {
          const code = (error as ControllerError)?.code;
          if (code !== "not_found" && code !== "unavailable") throw error;
          return null;
        }
      };

      const bindBackendSession = (providerSessionId: string, session: SessionState, backendSessionId: string) => {
        if (session.backendSessionId === backendSessionId) return;
        session.backendSessionId = backendSessionId;
        session.activeRunId = null;
        session.activeTurnId = null;
        emitPersistence(providerSessionId, session);
      };

      const submitPrompt = async (providerSessionId: string, session: SessionState, prompt: string) => {
        if (session.backendSessionId) {
          try {
            const status = await callController<any>({ op: "status", session_id: session.backendSessionId });
            const current = status?.session;
            const workspaceMatches =
              !current?.workspace?.active_root || current.workspace.active_root === session.cwd;
            if (workspaceMatches && current?.live && current.accepting_tasks !== false) {
              try {
                return await callController<any>({
                  op: "submit",
                  session_id: session.backendSessionId,
                  prompt,
                });
              } catch (error) {
                if (!isRecoverableBackendError(error)) throw error;
              }
            }
          } catch (error) {
            if (!isRecoverableBackendError(error)) throw error;
          }
        }

        const run = await dispatchAvailableBackend(session.cwd, prompt);
        bindBackendSession(providerSessionId, session, run.session_id);
        return run;
      };

      const waitForRun = async (
        providerSessionId: string,
        session: SessionState,
        backendSessionId: string,
        runId: string,
        turnId: string,
      ) => {
        const toolSnapshots = new Map<string, string>();
        const processedShellChunks = new Set<number>();
        const shellProcesses = new Map<
          string,
          { itemId: string; command: string; cwd?: string; output: string; terminal: boolean }
        >();
        const emitToolProgress = async () => {
          try {
            const status = await callController<any>({ op: "status", session_id: backendSessionId });
            const taskSeq = Array.isArray(status?.tasks) ? status.tasks.at(-1)?.command_seq : null;
            if (typeof taskSeq !== "number" || !Array.isArray(status?.timeline)) return;

            const latestBySeq = new Map<number, any>();
            for (const entry of status.timeline) {
              if (entry?.command_seq !== taskSeq || typeof entry?.seq !== "number") continue;
              if (entry.kind !== "tool_started" && entry.kind !== "tool_completed") continue;
              const previous = latestBySeq.get(entry.seq);
              if (!previous || entry.kind === "tool_completed") latestBySeq.set(entry.seq, entry);
            }

            for (const [seq, entry] of [...latestBySeq.entries()].sort(([a], [b]) => a - b)) {
              const tool = typeof entry.tool === "string" && entry.tool ? entry.tool : "tool";
              let nextState = toolCallStatus(entry);
              if (!nextState) continue;

              let itemId = `tool-${turnId}-${seq}`;
              let name = tool === "exec_command" ? "shell" : tool;
              let detail = toolCallDetail(tool, entry);
              let error = nextState === "failed" ? failedToolError(tool, entry) : null;

              if (tool === "exec_command") {
                const input = parsePreview(entry.request_preview);
                const result = normalizedToolResult(entry);
                const command = typeof input?.cmd === "string" ? input.cmd : null;
                const cwd = typeof input?.workdir === "string" && input.workdir ? input.workdir : undefined;
                if (command && entry.kind === "tool_completed") {
                  if (result.exitCode !== undefined) {
                    nextState = result.exitCode === 0 ? "completed" : "failed";
                    error = nextState === "failed" ? failedToolError(tool, entry) : null;
                  } else if (result.sessionId !== undefined) {
                    const processKey = String(result.sessionId);
                    let process = shellProcesses.get(processKey);
                    if (!process) {
                      process = { itemId, command, cwd, output: "", terminal: false };
                      shellProcesses.set(processKey, process);
                    } else if (process.terminal) {
                      continue;
                    }
                    if (!processedShellChunks.has(seq) && result.output) {
                      process.output += result.output;
                      processedShellChunks.add(seq);
                    }
                    nextState = "running";
                    detail = shellDetail(command, cwd, process.output || undefined, undefined, false);
                    error = null;
                  }
                }
              } else if (tool === "write_stdin") {
                const input = parsePreview(entry.request_preview);
                const processKey =
                  typeof input?.session_id === "string" || typeof input?.session_id === "number"
                    ? String(input.session_id)
                    : null;
                const process = processKey ? shellProcesses.get(processKey) : null;
                if (entry.kind === "tool_started" && process) continue;

                const result = normalizedToolResult(entry);
                if (process) {
                  if (!processedShellChunks.has(seq) && result.output) {
                    process.output += result.output;
                    processedShellChunks.add(seq);
                  }
                  itemId = process.itemId;
                  name = "shell";
                  if (result.exitCode !== undefined) {
                    nextState = result.exitCode === 0 ? "completed" : "failed";
                  } else if (result.sessionId !== undefined) {
                    nextState = "running";
                  }
                  detail = shellDetail(
                    process.command,
                    process.cwd,
                    process.output || undefined,
                    result.exitCode,
                    nextState === "failed",
                  );
                  error =
                    nextState === "failed"
                      ? {
                          content:
                            result.exitCode !== undefined
                              ? `Process exited with code ${result.exitCode}`
                              : process.output.trim() || "shell process failed",
                        }
                      : null;
                  if (result.sessionId !== undefined && result.exitCode === undefined) {
                    shellProcesses.set(String(result.sessionId), process);
                  }
                  if (result.exitCode !== undefined && processKey) {
                    process.terminal = true;
                  }
                } else {
                  name = "shell";
                  detail = {
                    type: "plain_text",
                    label: processKey ? `process ${processKey}` : "process output",
                    ...(result.output ? { text: result.output } : {}),
                    icon: "square_terminal",
                  };
                  error = nextState === "failed" ? failedToolError(tool, entry) : null;
                }
              }

              const signature = JSON.stringify({ nextState, detail, error });
              if (toolSnapshots.get(itemId) === signature) continue;
              toolSnapshots.set(itemId, signature);
              emitTimeline(
                providerSessionId,
                session,
                {
                  id: itemId,
                  type: "tool_call",
                  callId: itemId,
                  name,
                  detail,
                  status: nextState,
                  error,
                  metadata: {
                    backendToolSeq: seq,
                    backendTaskSeq: taskSeq,
                    backendTool: tool,
                    ...(typeof entry.duration_ms === "number" ? { durationMs: entry.duration_ms } : {}),
                  },
                },
                typeof entry.at_ms === "number" ? new Date(entry.at_ms).toISOString() : undefined,
              );
            }
          } catch {
            // Progress is best-effort; terminal run state remains authoritative.
          }
        };

        try {
          while (!closed && !session.closed) {
            try {
              const run = await callController<any>({
                op: "wait",
                session_id: backendSessionId,
                run_id: runId,
                timeout_ms: PROGRESS_POLL_MS,
              });
              await emitToolProgress();
              if (!isTerminalState(run.state)) continue;

              if (run.state === "succeeded") {
                emitTimeline(providerSessionId, session, {
                  id: `assistant-${turnId}`,
                  type: "assistant_message",
                  text: run.result ?? "",
                });
                emit({ type: "session.turn", sessionId: providerSessionId, turnId, state: "completed" });
              } else if (
                run.state === "cancelled" ||
                (run.state === "stale" &&
                  (interruptedRunIds.has(runId) || /interrupt|cancel/i.test(String(run.error ?? ""))))
              ) {
                emit({
                  type: "session.turn",
                  sessionId: providerSessionId,
                  turnId,
                  state: "canceled",
                  error: {
                    message: run.error ?? (run.state === "stale"
                      ? "Interrupted by Paseo; backend session abandoned after cancel timeout"
                      : "Cancelled"),
                  },
                });
              } else {
                emit({
                  type: "session.turn",
                  sessionId: providerSessionId,
                  turnId,
                  state: "failed",
                  error: {
                    message: run.error ?? (run.state === "stale" ? "ChatGPT backend session became stale" : "Backend run failed"),
                    ...(run.state === "stale" ? { code: "unavailable" } : {}),
                  },
                });
              }
              return;
            } catch (error) {
              if ((error as ControllerError)?.code === "timed_out") {
                await emitToolProgress();
                continue;
              }
              throw error;
            }
          }
        } catch (error) {
          emit({
            type: "session.turn",
            sessionId: providerSessionId,
            turnId,
            state: "failed",
            error: providerError(error),
          });
        } finally {
          interruptedRunIds.delete(runId);
          if (session.activeRunId === runId) {
            session.activeRunId = null;
            session.activeTurnId = null;
          }
        }
      };

      const send = async (input: any): Promise<void> => {
        if (closed) throw new Error("Provider connection is closed");
        switch (input.type) {
          case "catalog": {
            try {
              await callController({
                op: "pool",
                ...(typeof input.cwd === "string" && input.cwd ? { workspace: input.cwd } : {}),
              });
              emit({
                type: "catalog",
                requestId: input.requestId,
                catalog: {
                  models: [{ id: "chatgpt", label: "Attached ChatGPT", isDefault: true }],
                  modes: [],
                  thinkingOptions: [],
                  defaultModel: "chatgpt",
                },
              });
            } catch (error) {
              emit({ type: "request.failed", requestId: input.requestId, error: providerError(error) });
            }
            return;
          }

          case "session.open": {
            const restoredSessionId = restoredBackendSessionId(input.persistence);
            try {
              const backendSession = await resolveRestoredBackendSession(input.config.cwd, restoredSessionId);
              const state: SessionState = {
                backendSessionId: backendSession?.session_id ?? null,
                cwd: input.config.cwd,
                activeRunId: backendSession?.active_run_id ?? null,
                activeTurnId: backendSession?.active_run_id ?? null,
                closed: false,
                persist: input.config.persist,
                timeline: restoredTimeline(input.persistence),
              };
              sessions.set(input.sessionId, state);
              emit({
                type: "session.opened",
                requestId: input.requestId,
                sessionId: input.sessionId,
                capabilities,
                restoration: "core",
                persistence: persistenceHandle(state),
                cwd: state.cwd,
                title: "ChatGPT via Codexify",
              });
              emit({
                type: "session.config",
                sessionId: input.sessionId,
                config: {
                  model: "chatgpt",
                  models: [{ id: "chatgpt", label: "Attached ChatGPT", isDefault: true }],
                  modes: [],
                  thinkingOptions: [],
                  settings: [],
                },
              });
              for (const entry of state.timeline) {
                emit({
                  type: "timeline.item",
                  sessionId: input.sessionId,
                  item: entry.item,
                  ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
                });
              }
              emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
              if (state.activeRunId && state.activeTurnId) {
                if (!state.backendSessionId) throw new Error("Restored active ChatGPT backend run has no backend session");
                void waitForRun(input.sessionId, state, state.backendSessionId, state.activeRunId, state.activeTurnId);
              }
            } catch (error) {
              emit({ type: "request.failed", requestId: input.requestId, error: providerError(error) });
            }
            return;
          }

          case "session.prompt": {
            const session = sessions.get(input.sessionId);
            if (!session || session.closed) throw new Error(`Unknown provider session ${input.sessionId}`);
            if (session.activeRunId && session.activeTurnId) {
              try {
                if (!session.backendSessionId) throw new Error("Active ChatGPT backend turn has no backend session");
                const instruction = promptText(input.prompt.input);
                await callController({
                  op: "steer",
                  session_id: session.backendSessionId,
                  run_id: session.activeRunId,
                  instruction,
                });
                emitTimeline(input.sessionId, session, {
                  id: `user-${input.prompt.clientMessageId}`,
                  type: "user_message",
                  text: instruction,
                  clientMessageId: input.prompt.clientMessageId,
                });
                emit({
                  type: "session.prompt_result",
                  sessionId: input.sessionId,
                  clientMessageId: input.prompt.clientMessageId,
                  result: { type: "steer", turnId: session.activeTurnId },
                });
              } catch (error) {
                emit({
                  type: "session.prompt_result",
                  sessionId: input.sessionId,
                  clientMessageId: input.prompt.clientMessageId,
                  result: { type: "failed", error: providerError(error) },
                });
              }
              return;
            }

            if (input.prompt.delivery === "steer") {
              emit({
                type: "session.prompt_result",
                sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: { type: "failed", error: { message: "No active ChatGPT backend turn to steer", code: "unavailable" } },
              });
              return;
            }

            try {
              const text = promptText(input.prompt.input);
              const run = await submitPrompt(input.sessionId, session, text);
              if (!session.backendSessionId) throw new Error("ChatGPT backend dispatch did not bind a backend session");
              const backendSessionId = session.backendSessionId;
              const turnId = run.run_id as string;
              session.activeRunId = run.run_id;
              session.activeTurnId = turnId;
              emit({
                type: "session.prompt_result",
                sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: { type: "turn", turnId },
              });
              emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
              emitTimeline(input.sessionId, session, {
                id: `user-${input.prompt.clientMessageId}`,
                type: "user_message",
                text,
                clientMessageId: input.prompt.clientMessageId,
              });
              void waitForRun(input.sessionId, session, backendSessionId, run.run_id, turnId);
            } catch (error) {
              emit({
                type: "session.prompt_result",
                sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: { type: "failed", error: providerError(error) },
              });
            }
            return;
          }

          case "session.interrupt": {
            const session = sessions.get(input.sessionId);
            try {
              const runId = session?.activeRunId ?? null;
              if (session && runId) {
                if (!session.backendSessionId) throw new Error("Active ChatGPT backend turn has no backend session");
                interruptedRunIds.add(runId);
                try {
                  await callController({
                    op: "cancel",
                    session_id: session.backendSessionId,
                    run_id: runId,
                    reason: "Interrupted by Paseo",
                  });
                } catch (error) {
                  if ((error as ControllerError)?.code !== "conflict") throw error;
                }

                // Acknowledge the interrupt as soon as cancellation is accepted.
                // The ChatGPT turn may need a tool boundary to observe cancel;
                // waiting for that here makes Paseo treat a valid interrupt as
                // unacknowledged. Terminalization/recovery happens asynchronously.
                emit({ type: "request.completed", requestId: input.requestId });

                void (async () => {
                  const deadline = Date.now() + INTERRUPT_GRACE_MS;
                  while (session.activeRunId === runId && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                  if (session.activeRunId === runId) {
                    await callController({
                      op: "abandon",
                      session_id: session.backendSessionId,
                      reason: "Paseo interrupt acknowledgement timed out",
                    });
                  }
                })().catch((error) => {
                  console.warn(`[chatgpt-codexify] interrupt watchdog failed: ${error instanceof Error ? error.message : String(error)}`);
                });
                return;
              }

              emit({ type: "request.completed", requestId: input.requestId });
            } catch (error) {
              emit({ type: "request.failed", requestId: input.requestId, error: providerError(error) });
            }
            return;
          }

          case "session.close": {
            const session = sessions.get(input.sessionId);
            // Closing a Paseo runtime is only a transport detach. The attached
            // ChatGPT backend session is durable and may be restored immediately.
            // Cancellation is handled explicitly by session.interrupt.
            if (session) {
              session.closed = true;
              sessions.delete(input.sessionId);
            }
            emit({ type: "session.closed", sessionId: input.sessionId });
            return;
          }

          default:
            if ("requestId" in input) {
              emit({
                type: "request.failed",
                requestId: input.requestId,
                error: { message: `Unsupported ChatGPT Codexify provider operation: ${input.type}`, code: "unsupported" },
              });
              return;
            }
            throw new Error(`Unsupported ChatGPT Codexify provider operation: ${input.type}`);
        }
      };

      return {
        version: PROVIDER_PROTOCOL_VERSION,
        capabilities: [...capabilities],
        send,
        onEvent(listener: (event: any) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          closed = true;
          listeners.clear();
        },
      };
    },
  };
}
