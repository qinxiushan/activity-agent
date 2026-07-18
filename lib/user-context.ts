import os from "node:os";
import { DEFAULT_USER_ID } from "./user-preferences";
import { getAuthMode, type AuthMode } from "./auth-mode";
import { AUTH_COOKIE_NAME } from "./auth-constants";
import {
  readCookie,
  verifyAuthSessionToken,
} from "./auth-session";

function fromOS(): string {
  return os.userInfo().username || DEFAULT_USER_ID;
}

export function getCurrentUserId(): string {
  return fromOS();
}

export function getCurrentUserIdFromRequest(req: Request): string {
  const context = resolveUserContext(req);
  return context.userId ?? DEFAULT_USER_ID;
}

export interface ResolvedUserContext {
  mode: AuthMode;
  userId: string | null;
  username: string | null;
  authed: boolean;
  isDev: boolean;
  source: "auth" | "header" | "cookie" | "os";
}

export function resolveUserContext(req: Request): ResolvedUserContext {
  const mode = getAuthMode();
  const authToken = readCookie(req, AUTH_COOKIE_NAME);
  const authSession = verifyAuthSessionToken(authToken);

  if (authSession) {
    return {
      mode,
      userId: authSession.userId,
      username: authSession.username,
      authed: true,
      isDev: false,
      source: "auth",
    };
  }

  if (mode === "required") {
    return {
      mode,
      userId: null,
      username: null,
      authed: false,
      isDev: false,
      source: "auth",
    };
  }

  const headerUid = req.headers.get("x-user-id");
  if (headerUid) {
    return {
      mode,
      userId: headerUid,
      username: null,
      authed: false,
      isDev: false,
      source: "header",
    };
  }

  const legacyCookie = readCookie(req, "pi_user");
  if (legacyCookie) {
    return {
      mode,
      userId: legacyCookie,
      username: null,
      authed: false,
      isDev: true,
      source: "cookie",
    };
  }

  return {
    mode,
    userId: fromOS(),
    username: null,
    authed: false,
    isDev: false,
    source: "os",
  };
}
