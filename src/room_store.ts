import type { MapId, RoomMode, RoomSummary } from "./protocol.js";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface PeerRecord {
  connectionId: string;
  userId: string;
  displayName: string;
  peerId: number;
}

export interface RoomRecord {
  code: string;
  mode: RoomMode;
  mapId: MapId;
  hostConnectionId: string;
  peers: Map<string, PeerRecord>;
  lastActivityAt: number;
  locked: boolean;
}

export class RoomStore {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly connectionRooms = new Map<string, string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly codeFactory: () => string = defaultRoomCode,
  ) {}

  createRoom(host: Omit<PeerRecord, "peerId">, mode: RoomMode, mapId: MapId): RoomRecord {
    this.leave(host.connectionId);
    let code = this.codeFactory();
    for (let attempt = 0; this.rooms.has(code) && attempt < 20; attempt += 1) code = this.codeFactory();
    if (this.rooms.has(code)) throw new Error("room_code_exhausted");
    const hostPeer: PeerRecord = { ...host, peerId: 1 };
    const room: RoomRecord = {
      code,
      mode,
      mapId,
      hostConnectionId: host.connectionId,
      peers: new Map([[host.connectionId, hostPeer]]),
      lastActivityAt: this.now(),
      locked: false,
    };
    this.rooms.set(code, room);
    this.connectionRooms.set(host.connectionId, code);
    return room;
  }

  joinRoom(code: string, peer: Omit<PeerRecord, "peerId">): PeerRecord {
    this.leave(peer.connectionId);
    const room = this.rooms.get(code);
    if (!room) throw new Error("room_not_found");
    if (room.locked) throw new Error("room_locked");
    const capacity = room.mode === "duel" ? 2 : 12;
    if (room.peers.size >= capacity) throw new Error("room_full");
    if ([...room.peers.values()].some((current) => current.userId === peer.userId)) {
      throw new Error("user_already_joined");
    }
    const used = new Set([...room.peers.values()].map((current) => current.peerId));
    let peerId = 2;
    while (used.has(peerId)) peerId += 1;
    const joined: PeerRecord = { ...peer, peerId };
    room.peers.set(peer.connectionId, joined);
    room.lastActivityAt = this.now();
    this.connectionRooms.set(peer.connectionId, code);
    return joined;
  }

  roomForConnection(connectionId: string): RoomRecord | undefined {
    const code = this.connectionRooms.get(connectionId);
    return code ? this.rooms.get(code) : undefined;
  }

  /** Only the host connection may lock its room (no more joins, e.g. match started). */
  lockRoom(connectionId: string): RoomRecord {
    const room = this.roomForConnection(connectionId);
    if (!room) throw new Error("room_required");
    if (room.hostConnectionId !== connectionId) throw new Error("host_required");
    room.locked = true;
    room.lastActivityAt = this.now();
    return room;
  }

  peerById(room: RoomRecord, peerId: number): PeerRecord | undefined {
    return [...room.peers.values()].find((peer) => peer.peerId === peerId);
  }

  touch(connectionId: string): void {
    const room = this.roomForConnection(connectionId);
    if (room) room.lastActivityAt = this.now();
  }

  leave(connectionId: string): { room?: RoomRecord; peer?: PeerRecord; closed: boolean } {
    const room = this.roomForConnection(connectionId);
    if (!room) return { closed: false };
    const peer = room.peers.get(connectionId);
    this.connectionRooms.delete(connectionId);
    if (room.hostConnectionId === connectionId) {
      for (const id of room.peers.keys()) this.connectionRooms.delete(id);
      this.rooms.delete(room.code);
      return { room, peer, closed: true };
    }
    room.peers.delete(connectionId);
    room.lastActivityAt = this.now();
    return { room, peer, closed: false };
  }

  removeIdle(ttlMs: number): RoomRecord[] {
    const expired: RoomRecord[] = [];
    for (const room of this.rooms.values()) {
      if (this.now() - room.lastActivityAt <= ttlMs) continue;
      expired.push(room);
      for (const id of room.peers.keys()) this.connectionRooms.delete(id);
      this.rooms.delete(room.code);
    }
    return expired;
  }

  listActiveRooms(): RoomSummary[] {
    const result: RoomSummary[] = [];
    for (const room of this.rooms.values()) {
      if (room.locked) continue;
      const maxPlayers = room.mode === "duel" ? 2 : 12;
      result.push({
        roomCode: room.code,
        mode: room.mode,
        mapId: room.mapId,
        playerCount: room.peers.size,
        maxPlayers,
        locked: room.locked,
      });
    }
    return result;
  }
}

export function defaultRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}
