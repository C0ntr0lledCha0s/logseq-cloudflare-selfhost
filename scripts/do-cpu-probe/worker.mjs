// A throwaway Worker and SQLite-backed Durable Object for the do-cpu-probe workflow
// (.github/workflows/do-cpu-probe.yml). It measures what the Free plan does when a Durable Object
// runs long synchronous work, as a datalog query does in the graph's sync DO. Nothing here touches
// the sync server; the workflow deploys it under a unique name and deletes it afterwards.
//
// Every route except /health needs ?key=<PROBE_KEY>, a random value the workflow generates per run,
// so nobody else can make the public workers.dev URL burn CPU while it exists.
//
//   GET /health                  the front Worker alone (no DO): proves the deploy is reachable
//   GET /mark?token=T            stores T in the DO's memory; returns the DO's state
//   GET /state                   returns the DO's state: { bootId, marker, burns }
//   GET /burn?iterations=N       runs burn(N) synchronously in the DO
//   GET /ws                      a WebSocket to the DO; "ping:X" answers "pong:X:<bootId>"
//
// bootId is random per DO instance, so a changed bootId (or a lost marker) means the instance was
// reset. The WebSocket uses the hibernation API, as upstream's sync DO does (handler/ws.cljs).
// A Worker module may export only handlers and classes (workerd refuses a constant export), so the
// shared constant lives in burn.mjs.
import { MAX_ITERATIONS, burn } from "./burn.mjs";

const ROUTES = new Set(["/mark", "/state", "/burn", "/ws"]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class ProbeDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.bootId = crypto.randomUUID();
    this.marker = null;
    this.burns = 0;
  }

  snapshot() {
    return { bootId: this.bootId, marker: this.marker, burns: this.burns };
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/ws": {
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return json({ error: "expected a WebSocket upgrade" }, 426);
        }
        const pair = new WebSocketPair();
        this.state.acceptWebSocket(pair[1]);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      case "/mark":
        this.marker = url.searchParams.get("token");
        return json(this.snapshot());
      case "/state":
        return json(this.snapshot());
      case "/burn": {
        const raw = url.searchParams.get("iterations") ?? "";
        const iterations = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!(iterations > 0 && iterations <= MAX_ITERATIONS)) {
          return json({ error: `iterations must be a whole number from 1 to ${MAX_ITERATIONS}, got ${JSON.stringify(raw)}` }, 400);
        }
        const checksum = burn(iterations);
        this.burns += 1;
        return json({ iterations, checksum, ...this.snapshot() });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  }

  webSocketMessage(ws, message) {
    if (typeof message === "string" && message.startsWith("ping:")) {
      ws.send(`pong:${message.slice(5)}:${this.bootId}`);
    }
  }

  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (!ROUTES.has(url.pathname)) return json({ error: "not found" }, 404);
    if (!env.PROBE_KEY || url.searchParams.get("key") !== env.PROBE_KEY) return json({ error: "forbidden" }, 403);
    const stub = env.PROBE.get(env.PROBE.idFromName("probe"));
    try {
      return await stub.fetch(request);
    } catch (error) {
      // What a CPU-limit kill (or any DO failure) looks like to the calling Worker: the message and
      // the flags Cloudflare sets on Durable Object errors.
      return json(
        {
          error: String(error?.message ?? error),
          name: error?.name ?? null,
          remote: error?.remote ?? null,
          retryable: error?.retryable ?? null,
          overloaded: error?.overloaded ?? null,
          durableObjectReset: error?.durableObjectReset ?? null,
        },
        502,
      );
    }
  },
};
