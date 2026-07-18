import { createHmac, timingSafeEqual, scryptSync } from "node:crypto";
import { getPool, isDbConfigured } from "./db";
import { AUTH_COOKIE_NAME } from "./auth-constants";

export interface AuthSessionPayload {
  userId: string;
  username: string;
  iat: number;
}

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
}

function toBase64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64");
}

function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is required for authenticated sessions");
  }
  return secret;
}

function sign(encodedPayload: string): string {
  return toBase64Url(createHmac("sha256", getAuthSecret()).update(encodedPayload).digest());
}

export function createAuthSessionToken(payload: AuthSessionPayload): string {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyAuthSessionToken(token: string | null | undefined): AuthSessionPayload | null {
  if (!token) return null;
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSignature = sign(encodedPayload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload).toString("utf-8")) as AuthSessionPayload;
    if (!payload.userId || !payload.username || typeof payload.iat !== "number") return null;
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function buildAuthCookie(token: string): string {
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
}

export function buildClearAuthCookie(): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`;
}

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  if (!isDbConfigured()) return null;
  const { rows } = await getPool().query(
    "SELECT id, username, password_hash FROM users WHERE username=$1",
    [username],
  );
  if (rows.length === 0) return null;
  const row = rows[0] as { id: string; username: string; password_hash: string };
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
  };
}

export function hashPassword(password: string): string {
  const salt = "activity-agent-auth-v1";
  return scryptSync(password, salt, 64).toString("hex");
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  return hashPassword(password) === passwordHash;
}
