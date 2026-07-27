import { compareSync, hashSync } from "bcryptjs";
import { getPool, isDbConfigured } from "./db";

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
}

export function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
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
  return hashSync(password, 12);
}

export function verifyPassword(password: string, passwordHash: string): boolean {
  return compareSync(password, passwordHash);
}
