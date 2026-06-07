import os from "node:os";
import { DEFAULT_USER_ID } from "./user-preferences";

function fromOS(): string {
  return os.userInfo().username || DEFAULT_USER_ID;
}

export function getCurrentUserId(): string {
  return fromOS();
}

export function getCurrentUserIdFromRequest(req: Request): string {
  const headerUid = req.headers.get("x-user-id");
  if (headerUid) return headerUid;

  const cookieHeader = req.headers.get("cookie") ?? "";
  const m = cookieHeader.match(/(?:^|;\s*)pi_user=([^;]+)/);
  if (m && m[1]) return decodeURIComponent(m[1]);

  return fromOS();
}
