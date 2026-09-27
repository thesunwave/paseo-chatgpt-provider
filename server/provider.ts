import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const PROVIDER_PROTOCOL_VERSION = 1;
const DEFAULT_SOCKET_PATH = "/Users/Shared/codexify-chatgpt/backend.sock";
const INTERRUPT_GRACE_MS = 20_000;
const SUPPORTED_CAPABILITIES = ["prompt.message", "prompt.steer", "session.persistence"] as const;

type JsonRecord = Record<string, unknown>;

type ControllerError = Error & { code?: string };

type SessionState = {
  backendSessionId: string;
  cwd: string;
  activeRunId: string | null;
  activeTurnId: string | null;
  closed: boolean;
  persist: boolean;
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
    version: 1,
    data: {
      backendSessionId: session.backendSessionId,
      cwd: session.cwd,
    },
  };
}

function restoredBackendSessionId(persistence: any): string | null {
  if (!persistence || persistence.version !== 1 || typeof persistence.data !== "object" || persistence.data === null) {
    return null;
  }
  return typeof persistence.data.backendSessionId === "string" ? persistence.data.backendSessionId : null;
}

function providerError(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as ControllerError).code;
    return { message: error.message, ...(code ? { code } : {}) };
  }
  return { message: String(error) };
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

export function createChatGptCodexifyProvider() {
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

      const waitForRun = async (providerSessionId: string, session: SessionState, runId: string, turnId: string) => {
        try {
          while (!closed && !session.closed) {
            try {
              const run = await controller<any>({
                op: "wait",
                session_id: session.backendSessionId,
                run_id: runId,
                timeout_ms: 60_000,
              });
              if (!isTerminalState(run.state)) continue;

              if (run.state === "succeeded") {
                emit({
                  type: "timeline.item",
                  sessionId: providerSessionId,
                  item: {
                    id: `assistant-${turnId}`,
                    type: "assistant_message",
                    text: run.result ?? "",
                  },
                  timestamp: new Date().toISOString(),
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
              if ((error as ControllerError)?.code === "timed_out") continue;
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
              await controller({
                op: "acquire",
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
            try {
              const restoredSessionId = restoredBackendSessionId(input.persistence);
              const acquired = restoredSessionId
                ? await controller<any>({ op: "status", session_id: restoredSessionId })
                : await controller<any>({ op: "acquire", workspace: input.config.cwd });
              const backendSession = restoredSessionId ? acquired.session : acquired;
              if (!backendSession?.live) {
                throw Object.assign(new Error(`ChatGPT backend session ${restoredSessionId ?? ""} is unavailable`), { code: "unavailable" });
              }
              if (backendSession.workspace?.active_root && backendSession.workspace.active_root !== input.config.cwd) {
                throw Object.assign(new Error(`ChatGPT backend workspace mismatch: ${backendSession.workspace.active_root}`), { code: "conflict" });
              }
              const state: SessionState = {
                backendSessionId: backendSession.session_id,
                cwd: input.config.cwd,
                activeRunId: backendSession.active_run_id ?? null,
                activeTurnId: backendSession.active_run_id ?? null,
                closed: false,
                persist: input.config.persist,
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
              emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
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
                const instruction = promptText(input.prompt.input);
                await controller({
                  op: "steer",
                  session_id: session.backendSessionId,
                  run_id: session.activeRunId,
                  instruction,
                });
                emit({
                  type: "timeline.item",
                  sessionId: input.sessionId,
                  item: {
                    id: `user-${input.prompt.clientMessageId}`,
                    type: "user_message",
                    text: instruction,
                    clientMessageId: input.prompt.clientMessageId,
                  },
                  timestamp: new Date().toISOString(),
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
              const run = await controller<any>({
                op: "submit",
                session_id: session.backendSessionId,
                prompt: text,
              });
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
              emit({
                type: "timeline.item",
                sessionId: input.sessionId,
                item: {
                  id: `user-${input.prompt.clientMessageId}`,
                  type: "user_message",
                  text,
                  clientMessageId: input.prompt.clientMessageId,
                },
                timestamp: new Date().toISOString(),
              });
              void waitForRun(input.sessionId, session, run.run_id, turnId);
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
                interruptedRunIds.add(runId);
                try {
                  await controller({
                    op: "cancel",
                    session_id: session.backendSessionId,
                    run_id: runId,
                    reason: "Interrupted by Paseo",
                  });
                } catch (error) {
                  if ((error as ControllerError)?.code !== "conflict") throw error;
                }

                const deadline = Date.now() + INTERRUPT_GRACE_MS;
                while (session.activeRunId === runId && Date.now() < deadline) {
                  await new Promise((resolve) => setTimeout(resolve, 100));
                }
                if (session.activeRunId === runId) {
                  await controller({
                    op: "abandon",
                    session_id: session.backendSessionId,
                    reason: "Paseo interrupt acknowledgement timed out",
                  });
                  const settleDeadline = Date.now() + 2_000;
                  while (session.activeRunId === runId && Date.now() < settleDeadline) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
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
