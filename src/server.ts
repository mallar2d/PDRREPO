import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { verifySignalingTicket, type TicketIdentity } from "./auth.js";
import { parseClientSignal, type ServerSignal } from "./protocol.js";
import { RoomStore } from "./room_store.js";

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

interface ConnectionState {
  id: string;
  socket: WebSocket;
  identity?: TicketIdentity;
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const secret = process.env.KODLO_SIGNALING_SECRET ?? "";
// The shipped LAN helper has no backend secret inside it. It is deliberately
// limited to a host's local signaling process; internet deployments keep JWT
// ticket verification enabled.
const insecureLocal = process.env.KODLO_LOCAL_SIGNALING_INSECURE === "1";
const ttlMs = Number(process.env.ROOM_IDLE_TTL_MS ?? 30_000);
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
if (!insecureLocal && secret.length < 32) throw new Error("KODLO_SIGNALING_SECRET must contain at least 32 characters");
// STUN/TURN servers pushed to every client after auth, so nobody configures ICE by hand.
// Format: JSON array of RTCIceServer objects, e.g. [{"urls":["turn:turn.example.com:3478"],"username":"u","credential":"p"}]
const iceServers: unknown[] = (() => {
  const raw = (process.env.KODLO_ICE_SERVERS ?? "").trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("KODLO_ICE_SERVERS must be a JSON array of ICE server objects");
  return parsed;
})();

const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, protocolVersion: 1 }));
    return;
  }
  response.writeHead(404).end();
});
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 70_000 });
const rooms = new RoomStore();
const connections = new Map<string, ConnectionState>();

httpServer.on("upgrade", (request, socket, head) => {
  // Godot / native clients often omit Origin; only enforce when Origin is present.
  const origin = request.headers.origin;
  const originBlocked =
    allowedOrigins.size > 0 && typeof origin === "string" && origin.length > 0 && !allowedOrigins.has(origin);
  if (request.url !== "/ws" || originBlocked) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => webSocketServer.emit("connection", webSocket));
});

webSocketServer.on("connection", (socket) => {
  const state: ConnectionState = { id: randomUUID(), socket };
  connections.set(state.id, state);
  const authTimer = setTimeout(() => socket.close(4001, "authentication_timeout"), 5_000);

  socket.on("message", async (buffer, isBinary) => {
    if (isBinary) return sendError(state, "invalid_message", "Binary messages are not supported");
    const message = parseClientSignal(buffer.toString("utf8"));
    if (!message) return sendError(state, "invalid_message", "Message does not match protocol v1");

      if (!state.identity) {
        if (message.type !== "authenticate") return sendError(state, "authentication_required", "Authenticate first");
        try {
        state.identity = insecureLocal
          ? { userId: `lan-${state.id}`, displayName: "Гравець" }
          : await verifySignalingTicket(message.token, secret);
        clearTimeout(authTimer);
        send(state, { type: "authenticated", ...state.identity, iceServers });
      } catch {
        sendError(state, "invalid_ticket", "Ticket is invalid or expired");
        socket.close(4003, "invalid_ticket");
      }
      return;
    }

    if (message.type === "authenticate") return sendError(state, "already_authenticated", "Connection is already authenticated");
    if (message.type === "heartbeat") {
      rooms.touch(state.id);
      return send(state, { type: "heartbeat_ack", serverTime: Date.now() });
    }
    if (message.type === "create_room") {
      const room = rooms.createRoom({ connectionId: state.id, ...state.identity }, message.mode, message.mapId);
      return send(state, { type: "room_created", roomCode: room.code, peerId: 1, mode: room.mode, mapId: room.mapId });
    }
    if (message.type === "join_room") {
      try {
        const joined = rooms.joinRoom(message.roomCode, { connectionId: state.id, ...state.identity });
        const room = rooms.roomForConnection(state.id)!;
        send(state, {
          type: "room_joined",
          roomCode: room.code,
          peerId: joined.peerId,
          hostPeerId: 1,
          mode: room.mode,
          mapId: room.mapId,
          // New clients need every current player, not just themselves and host.
          peers: [...room.peers.values()].map((peer) => ({ peerId: peer.peerId, displayName: peer.displayName })),
        });
        broadcast(room, { type: "peer_joined", peerId: joined.peerId, displayName: joined.displayName }, state.id);
      } catch (error) {
        const code = error instanceof Error ? error.message : "join_failed";
        sendError(state, code, "Unable to join room");
      }
      return;
    }
    if (message.type === "leave_room") return leaveConnection(state, false);
    if (message.type === "lock_room") {
      try {
        const room = rooms.lockRoom(state.id);
        broadcast(room, { type: "room_locked" });
      } catch (error) {
        const code = error instanceof Error ? error.message : "lock_failed";
        sendError(state, code, "Unable to lock room");
      }
      return;
    }

    const room = rooms.roomForConnection(state.id);
    const source = room?.peers.get(state.id);
    if (!room || !source) return sendError(state, "room_required", "Join a room first");
    const target = rooms.peerById(room, message.targetPeerId);
    if (!target || target.connectionId === state.id) return sendError(state, "invalid_target", "Target peer is not in this room");
    const targetState = connections.get(target.connectionId);
    if (!targetState) return sendError(state, "peer_unavailable", "Target peer is offline");
    send(targetState, { ...message, sourcePeerId: source.peerId });
    rooms.touch(state.id);
  });

  socket.on("close", () => {
    clearTimeout(authTimer);
    leaveConnection(state, true);
    connections.delete(state.id);
  });
});

function leaveConnection(state: ConnectionState, disconnected: boolean): void {
  const result = rooms.leave(state.id);
  if (!result.room || !result.peer) return;
  if (result.closed) broadcast(result.room, { type: "room_closed", reason: "host_left" }, state.id);
  else broadcast(result.room, { type: "peer_left", peerId: result.peer.peerId }, state.id);
  if (!disconnected) send(state, { type: "peer_left", peerId: result.peer.peerId });
}

function broadcast(room: { peers: Map<string, unknown> }, message: ServerSignal, exceptId?: string): void {
  for (const connectionId of room.peers.keys()) {
    if (connectionId === exceptId) continue;
    const target = connections.get(connectionId);
    if (target) send(target, message);
  }
}

function send(state: ConnectionState, message: ServerSignal): void {
  if (state.socket.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
}

function sendError(state: ConnectionState, code: string, message: string): void {
  send(state, { type: "error", code, message });
}

setInterval(() => {
  for (const room of rooms.removeIdle(ttlMs)) broadcast(room, { type: "room_closed", reason: "idle_timeout" });
}, Math.min(ttlMs, 10_000)).unref();

httpServer.listen(port, host, () => console.log(`Kodlo Arena signaling listening on ${host}:${port}`));
