function getErrorMessage(error?: string): string | null {
  switch (error) {
    case "invalid_credentials":
      return "用户名或密码错误";
    case "missing_credentials":
      return "请输入用户名和密码";
    case "auth_unavailable":
      return "登录服务暂不可用";
    case "invalid_json":
      return "登录请求格式错误";
    default:
      return null;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const errorParam = params?.error;
  const usernameParam = params?.username;
  const error = Array.isArray(errorParam) ? errorParam[0] : errorParam;
  const username = Array.isArray(usernameParam) ? usernameParam[0] : usernameParam;
  const errorMessage = getErrorMessage(error);

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
        action="/api/auth/login"
        method="post"
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
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>登录</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            AUTH_MODE=required 下必须登录后才能访问应用。
          </div>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
          用户名
          <input
            name="username"
            defaultValue={username ?? ""}
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
        {errorMessage && (
          <div style={{ fontSize: 12, color: "#ef4444" }}>{errorMessage}</div>
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
