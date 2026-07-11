import { jwtVerify, SignJWT } from "jose";

export interface TicketIdentity {
  userId: string;
  displayName: string;
}

const issuer = "kodlohub";
const audience = "kodlo-arena-signaling";

function secretKey(secret: string): Uint8Array {
  if (secret.length < 32) throw new Error("KODLO_SIGNALING_SECRET must contain at least 32 characters");
  return new TextEncoder().encode(secret);
}

export async function verifySignalingTicket(token: string, secret: string): Promise<TicketIdentity> {
  const { payload } = await jwtVerify(token, secretKey(secret), { issuer, audience });
  if (!payload.sub) throw new Error("Ticket has no subject");
  const displayName = typeof payload.name === "string" ? payload.name.trim().slice(0, 64) : "Гравець";
  return { userId: payload.sub, displayName: displayName || "Гравець" };
}

export async function createTestTicket(identity: TicketIdentity, secret: string): Promise<string> {
  return new SignJWT({ name: identity.displayName })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(identity.userId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(secretKey(secret));
}
