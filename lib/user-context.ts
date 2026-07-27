import os from "node:os";
import { auth } from "@/auth";
import { DEFAULT_USER_ID } from "./user-preferences";
import { getAuthMode, type AuthMode } from "./auth-mode";
import { readCookie } from "./auth-session";

function fromOS(): string {
  return os.userInfo().username || DEFAULT_USER_ID;
}

export function getCurrentUserId(): string {
  return fromOS();
}

export async function getCurrentUserIdFromRequest(req: Request): Promise<string> {
  const context = await resolveUserContext(req);
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
  sessionUser,
  headerUid,
  legacyCookie,
}: {
  sessionUser?: { id?: string | null; name?: string | null } | null;
  headerUid?: string | null;
  legacyCookie?: string | null;
}): ResolvedUserContext {
  const mode = getAuthMode();

  if (sessionUser?.id) {
    return {
      mode,
      userId: sessionUser.id,
      username: sessionUser.name ?? null,
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

export async function resolveUserContext(req: Request): Promise<ResolvedUserContext> {
  const session = await auth().catch(() => null);
  return resolveUserContextFromValues({
    sessionUser: session?.user ?? null,
    headerUid: req.headers.get("x-user-id"),
    legacyCookie: readCookie(req, "pi_user"),
  });
}
