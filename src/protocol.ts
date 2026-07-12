import { z } from "zod";

const targetPeerId = z.number().int().min(1).max(2_147_483_647);
const boundedSdp = z.string().min(1).max(64_000);

/** Maps playable in multiplayer lobbies (aligned with game catalog + legacy ids). */
export const mapIdSchema = z.enum([
  "blok_2200",
  "best_room",
  "contamination",
  "crossfire",
  "frenzy",
  "datacore",
  "disposal",
  "doublecross",
  "gasworks",
  "lambda_bunker",
  "pool_party",
  "rapidcore",
  "rocket_frenzy",
  "rustmill",
  "snark_pit",
  "stalkyard",
  "subtransit",
  "undertow",
  "xen_dm",
  "zhytomyr_station",
  "korostyshiv_quarry",
]);

export const clientSignalSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("authenticate"),
    token: z.string().min(16).max(4096),
    protocolVersion: z.literal(1),
  }),
  z.object({
    type: z.literal("create_room"),
    mode: z.enum(["ffa", "duel"]),
    mapId: mapIdSchema,
  }),
  z.object({
    type: z.literal("join_room"),
    roomCode: z.string().regex(/^[A-Z2-9]{6}$/),
  }),
  z.object({ type: z.literal("offer"), targetPeerId, sdp: boundedSdp }),
  z.object({ type: z.literal("answer"), targetPeerId, sdp: boundedSdp }),
  z.object({
    type: z.literal("ice_candidate"),
    targetPeerId,
    mid: z.string().max(256),
    index: z.number().int().min(0).max(256),
    candidate: z.string().min(1).max(8192),
  }),
  z.object({ type: z.literal("leave_room") }),
  z.object({ type: z.literal("lock_room") }),
  z.object({ type: z.literal("heartbeat") }),
]);

export type ClientSignal = z.infer<typeof clientSignalSchema>;
export type RoomMode = "ffa" | "duel";
export type MapId = z.infer<typeof mapIdSchema>;
export type RoomPeer = { peerId: number; displayName: string };

export type ServerSignal =
  | { type: "authenticated"; userId: string; displayName: string; iceServers: unknown[] }
  | { type: "room_created"; roomCode: string; peerId: 1; mode: RoomMode; mapId: MapId }
  | { type: "room_joined"; roomCode: string; peerId: number; hostPeerId: 1; mode: RoomMode; mapId: MapId; peers: RoomPeer[] }
  | { type: "peer_joined"; peerId: number; displayName: string }
  | { type: "peer_left"; peerId: number }
  | { type: "room_locked" }
  | ({ sourcePeerId: number } & Extract<ClientSignal, { type: "offer" | "answer" | "ice_candidate" }>)
  | { type: "room_closed"; reason: "host_left" | "idle_timeout" }
  | { type: "heartbeat_ack"; serverTime: number }
  | { type: "error"; code: string; message: string };

export function parseClientSignal(raw: string): ClientSignal | null {
  if (Buffer.byteLength(raw, "utf8") > 70_000) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = clientSignalSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
