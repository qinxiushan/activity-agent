import { headers } from "next/headers";
import { Suspense } from "react";
import { auth } from "@/auth";
import { AppShell } from "@/components/AppShell";
import { resolveUserContextFromValues } from "@/lib/user-context";

export default async function Home() {
  const headerStore = await headers();
  const session = await auth();
  const context = resolveUserContextFromValues({
    sessionUser: session?.user ?? null,
    legacyCookie: headerStore.get("cookie")?.match(/(?:^|;\s*)pi_user=([^;]+)/)?.[1] ?? null,
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
