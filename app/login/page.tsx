"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || body.error) {
        setError(body.error === "invalid_credentials" ? "用户名或密码错误" : "登录失败");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("登录失败");
    } finally {
      setSubmitting(false);
    }
  };

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
        onSubmit={handleSubmit}
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
            value={username}
            onChange={(e) => setUsername(e.target.value)}
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
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
          disabled={submitting}
          style={{
            height: 40,
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "var(--accent)",
            color: "#fff",
            cursor: submitting ? "wait" : "pointer",
            fontWeight: 600,
          }}
        >
          {submitting ? "登录中…" : "登录"}
        </button>
      </form>
    </main>
  );
}
