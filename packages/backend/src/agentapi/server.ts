import { Buffer } from "buffer";
import { createServer, type Server, type Socket } from "net";

const AGENT_API_PORT = 8771;
const AGENT_API_HOST = "127.0.0.1";
const SOCKET_IDLE_TIMEOUT_MS = 30_000;

export type AgentRoute = {
  method: string;
  path: string;
  handle: (
    query: URLSearchParams,
  ) => Promise<{ status: number; body: unknown }>;
};

const findHeaderEnd = (buffer: Buffer): number => {
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (
      buffer.readUInt8(index) === 13 &&
      buffer.readUInt8(index + 1) === 10 &&
      buffer.readUInt8(index + 2) === 13 &&
      buffer.readUInt8(index + 3) === 10
    ) {
      return index;
    }
  }
  return -1;
};

const writeResponse = (socket: Socket, status: number, body: unknown): void => {
  const payload = Buffer.from(JSON.stringify(body), "utf-8");
  const reason =
    status === 200
      ? "OK"
      : status === 400
        ? "Bad Request"
        : status === 404
          ? "Not Found"
          : "Internal Server Error";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${payload.length}\r\n` +
      "Connection: close\r\n\r\n",
  );
  socket.write(payload);
  socket.end();
};

export const startAgentApiServer = (
  routes: AgentRoute[],
  onError: (message: string) => void,
): Server => {
  const server = createServer((socket) => {
    let raw = Buffer.alloc(0);
    const fail = (status: number, message: string): void => {
      try {
        writeResponse(socket, status, { error: message });
      } catch {
        socket.destroy();
      }
    };

    socket.on("data", (chunk: Buffer) => {
      resetIdleTimer();
      void (async () => {
        raw = Buffer.concat([raw, chunk]);
        if (raw.length > 16_384) {
          raw = Buffer.alloc(0);
          fail(400, "Request header too large.");
          return;
        }
        const headerEnd = findHeaderEnd(raw);
        if (headerEnd < 0) return;
        // A complete request arrived: the connection is not abandoned, the
        // handler is just working. Stop the idle timer so long-running
        // sweeps are not killed mid-flight.
        stopIdleTimer();
        const requestLine = raw
          .subarray(0, headerEnd)
          .toString("utf-8")
          .split("\r\n")[0];
        raw = Buffer.alloc(0);
        if (requestLine === undefined) {
          fail(400, "Malformed request.");
          return;
        }
        const [method, target] = requestLine.split(" ");
        if (method === undefined || target === undefined) {
          fail(400, "Malformed request line.");
          return;
        }
        const url = new URL(target, "http://127.0.0.1");
        const route = routes.find(
          (candidate) =>
            candidate.method === method && candidate.path === url.pathname,
        );
        if (route === undefined) {
          fail(404, `No route for ${method} ${url.pathname}.`);
          return;
        }
        try {
          const result = await route.handle(url.searchParams);
          writeResponse(socket, result.status, result.body);
        } catch (error: unknown) {
          fail(500, error instanceof Error ? error.message : String(error));
        }
      })().catch(() => socket.destroy());
    });
    // This runtime has no socket-level timeout; enforce an idle timeout
    // manually so abandoned connections cannot accumulate.
    let idleTimer = setTimeout(() => socket.destroy(), SOCKET_IDLE_TIMEOUT_MS);
    // Once disarmed (a complete request arrived), the timer stays disarmed —
    // later data chunks must not re-arm it while the handler is working.
    let idleTimerArmed = true;
    const stopIdleTimer = (): void => {
      if (idleTimerArmed) clearTimeout(idleTimer);
      idleTimerArmed = false;
    };
    const resetIdleTimer = (): void => {
      if (!idleTimerArmed) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => socket.destroy(), SOCKET_IDLE_TIMEOUT_MS);
    };
    socket.on("close", () => stopIdleTimer());
    socket.on("error", () => socket.destroy());
  });

  server.on("error", (error: Error) => {
    onError(
      `GraphX agent API could not listen on ${AGENT_API_HOST}:${AGENT_API_PORT}: ${error.message}`,
    );
  });
  server.listen(AGENT_API_PORT, AGENT_API_HOST);
  return server;
};
