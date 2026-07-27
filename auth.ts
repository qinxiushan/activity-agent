import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { findUserByUsername, verifyPassword } from "@/lib/auth-session";
import { audit } from "@/lib/audit-logger";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        username: { label: "用户名" },
        password: { label: "密码", type: "password" },
      },
      async authorize(credentials) {
        const username = typeof credentials.username === "string"
          ? credentials.username.trim()
          : "";
        const password = typeof credentials.password === "string"
          ? credentials.password
          : "";
        if (!username || !password) return null;

        const user = await findUserByUsername(username);
        if (!user || !verifyPassword(password, user.passwordHash)) {
          audit({
            userId: user?.id ?? null,
            sessionId: null,
            eventType: "login_failed",
            detail: { username },
          });
          return null;
        }

        audit({
          userId: user.id,
          sessionId: null,
          eventType: "login",
          detail: { username: user.username },
        });

        return {
          id: user.id,
          name: user.username,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
        token.name = user.name ?? token.name;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.name = token.name ?? session.user.name;
      }
      return session;
    },
  },
});
