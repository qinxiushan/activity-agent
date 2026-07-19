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

export function resolveUserContextFromValues({
  authToken,
  headerUid,
  legacyCookie,
}: {
  authToken?: string | null;
  headerUid?: string | null;
  legacyCookie?: string | null;
}): ResolvedUserContext {
  const mode = getAuthMode();
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

export function resolveUserContext(req: Request): ResolvedUserContext {
  return resolveUserContextFromValues({
    authToken: readCookie(req, AUTH_COOKIE_NAME),
    headerUid: req.headers.get("x-user-id"),
    legacyCookie: readCookie(req, "pi_user"),
  });
}
