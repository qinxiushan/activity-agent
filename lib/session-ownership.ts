import type { SessionInfo } from "./types";
import { getPlanStateRepo } from "./storage";
import type { AuthMode } from "./auth-mode";

export async function canAccessSession(sessionId: string, userId: string, mode: AuthMode): Promise<boolean> {
  const planState = await getPlanStateRepo().load(sessionId);
  const ownerId = planState?.userId;
  if (!ownerId) return mode !== "required";
  return ownerId === userId;
}

export async function filterSessionsForUser(
  sessions: SessionInfo[],
  userId: string,
  mode: AuthMode,
): Promise<SessionInfo[]> {
  const states = await getPlanStateRepo().listAll();
  const ownerBySessionId = new Map(states.map((state) => [state.sessionId, state.userId]));
  return sessions.filter((session) => {
    const ownerId = ownerBySessionId.get(session.id);
    if (!ownerId) return mode !== "required";
    return ownerId === userId;
  });
}

export function canAccessOwner(ownerId: string | undefined, userId: string, mode: AuthMode): boolean {
  if (!ownerId) return mode !== "required";
  return ownerId === userId;
}
