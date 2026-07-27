import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";

type LoginPageProps = {
  searchParams?: Promise<{
    error?: string;
    username?: string;
  }>;
};

function getErrorMessage(error?: string | null): string | null {
  if (!error) return null;
  if (error === "CredentialsSignin" || error === "credentials") return "用户名或密码错误";
  return "登录失败";
}

async function loginAction(formData: FormData): Promise<void> {
  "use server";

  const username = String(formData.get("username") ?? "");
  try {
    await signIn("credentials", {
      username,
      password: String(formData.get("password") ?? ""),
      redirectTo: "/",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      redirect(`/login?error=CredentialsSignin&username=${encodeURIComponent(username)}`);
    }
    throw error;
  }
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const error = getErrorMessage(params?.error);

  return (
    <main style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--bg)",
      padding: 24,
    }}>
      <form
        action={loginAction}
        style={{
          width: "100%",
          maxWidth: 360,
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: "0 0 6px" }}>登录</h1>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            AUTH_MODE=required 下必须登录后才能访问应用。
          </div>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
          用户名
          <input
            name="username"
            defaultValue={params?.username ?? ""}
            autoComplete="username"
            style={{
              height: 38,
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
              padding: "0 12px",
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
          密码
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            style={{
              height: 38,
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
              padding: "0 12px",
            }}
          />
        </label>
        {error && (
          <div style={{ fontSize: 12, color: "#ef4444" }}>{error}</div>
        )}
        <button
          type="submit"
          style={{
            height: 40,
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "var(--accent)",
            color: "#fff",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          登录
        </button>
      </form>
    </main>
  );
}
