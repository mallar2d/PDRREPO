import { describe, expect, it } from "vitest";
import { RoomStore } from "../src/room_store.js";

const peer = (id: string) => ({ connectionId: id, userId: `user-${id}`, displayName: id });

describe("RoomStore", () => {
  it("assigns the host peer id 1 and clients increasing ids", () => {
    const store = new RoomStore(() => 100, () => "ABC234");
    const room = store.createRoom(peer("host"), "ffa", "blok_2200");
    const joined = store.joinRoom(room.code, peer("client"));
    expect(room.peers.get("host")?.peerId).toBe(1);
    expect(joined.peerId).toBe(2);
  });

  it("closes the room when its host leaves", () => {
    const store = new RoomStore(() => 100, () => "ABC234");
    const room = store.createRoom(peer("host"), "ffa", "blok_2200");
    store.joinRoom(room.code, peer("client"));
    expect(store.leave("host").closed).toBe(true);
    expect(store.roomForConnection("client")).toBeUndefined();
  });

  it("limits ffa rooms to twelve players", () => {
    const store = new RoomStore(() => 100, () => "ABC234");
    const room = store.createRoom(peer("host"), "ffa", "blok_2200");
    for (let i = 2; i <= 12; i += 1) {
      store.joinRoom(room.code, peer(`p${i}`));
    }
    expect(() => store.joinRoom(room.code, peer("overflow"))).toThrow("room_full");
  });

  it("limits duel rooms to two players", () => {
    const store = new RoomStore(() => 100, () => "ABC234");
    const room = store.createRoom(peer("host"), "duel", "korostyshiv_quarry");
    store.joinRoom(room.code, peer("client"));
    expect(() => store.joinRoom(room.code, peer("third"))).toThrow("room_full");
  });

  it("rejects joins after the host locks the room", () => {
    const store = new RoomStore(() => 100, () => "ABC234");
    const room = store.createRoom(peer("host"), "ffa", "blok_2200");
    store.joinRoom(room.code, peer("client"));
    expect(() => store.lockRoom("client")).toThrow("host_required");
    store.lockRoom("host");
    expect(() => store.joinRoom(room.code, peer("late"))).toThrow("room_locked");
  });

  it("removes idle rooms", () => {
    let now = 0;
    const store = new RoomStore(() => now, () => "ABC234");
    const room = store.createRoom(peer("host"), "ffa", "blok_2200");
    now = 31_000;
    expect(store.removeIdle(30_000)).toEqual([room]);
  });
});
