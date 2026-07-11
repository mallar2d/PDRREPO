import { describe, expect, it } from "vitest";
import { createTestTicket, verifySignalingTicket } from "../src/auth.js";
import { parseClientSignal } from "../src/protocol.js";

const secret = "test-secret-that-is-at-least-32-characters-long";

describe("signaling protocol", () => {
  it("rejects unknown and oversized messages", () => {
    expect(parseClientSignal('{"type":"root_shell"}')).toBeNull();
    expect(parseClientSignal("x".repeat(70_001))).toBeNull();
  });

  it("normalizes room codes through schema validation", () => {
    expect(parseClientSignal('{"type":"join_room","roomCode":"ABC234"}')).toEqual({ type: "join_room", roomCode: "ABC234" });
    expect(parseClientSignal('{"type":"join_room","roomCode":"abc123"}')).toBeNull();
  });

  it("accepts the lock_room message", () => {
    expect(parseClientSignal('{"type":"lock_room"}')).toEqual({ type: "lock_room" });
  });

  it("verifies a short-lived KodloHUB ticket", async () => {
    const token = await createTestTicket({ userId: "user-1", displayName: "Подро" }, secret);
    await expect(verifySignalingTicket(token, secret)).resolves.toEqual({ userId: "user-1", displayName: "Подро" });
    await expect(verifySignalingTicket(token, `${secret}-wrong`)).rejects.toThrow();
  });
});
