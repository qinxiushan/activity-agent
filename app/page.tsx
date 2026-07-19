import { cookies, headers } from "next/headers";
import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";
import { resolveUserContextFromValues } from "@/lib/user-context";

export default async function Home() {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const context = resolveUserContextFromValues({
    authToken: cookieStore.get(AUTH_COOKIE_NAME)?.value ?? null,
    legacyCookie: cookieStore.get("pi_user")?.value ?? null,
    headerUid: headerStore.get("x-user-id"),
  });
  const initialIdentity = context.userId
    ? {
        userId: context.userId,
        username: context.username,
        authed: context.authed,
        isDev: context.isDev,
        mode: context.mode,
      }
    : null;

  return (
    <Suspense>
      <AppShell initialIdentity={initialIdentity} />
    </Suspense>
  );
}
