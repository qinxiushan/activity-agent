-- 001_init.sql — 阶段 2 全量表结构（设计见 docs/分析报告/07-第二阶段开发计划.md §T1.2）
--
-- 约定：
-- * intent/plan/history/payload 等复杂结构用 JSONB 整体存，
--   与文件后端形状同构，降低双后端（file/postgres）漂移风险
-- * plan_states.user_id 在 T3（NextAuth）之前允许 NULL
-- * users / audit_logs 表由 T3 / T6 开始写入，schema 此处一次建齐
-- * schema_migrations 表由迁移器（scripts/db-migrate.ts）自行维护，不在本文件

-- ─── plan-state（原 ~/.pi/agent/plan-states/<sessionId>.json）────────────
CREATE TABLE IF NOT EXISTS plan_states (
  session_id          TEXT PRIMARY KEY,
  user_id             TEXT,
  phase               TEXT NOT NULL,
  turn_count          INT  NOT NULL DEFAULT 0,
  clarification_count INT  NOT NULL DEFAULT 0,
  intent              JSONB NOT NULL DEFAULT '{}',
  plan                JSONB,
  history             JSONB NOT NULL DEFAULT '[]',
  last_transition_at  BIGINT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_states_user ON plan_states(user_id);

-- ─── 订单（原 ~/.pi/agent/bookings/<orderId>.json）──────────────────────
CREATE TABLE IF NOT EXISTS bookings (
  order_id        TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  status          TEXT NOT NULL,
  restaurant_id   TEXT NOT NULL,
  restaurant_name TEXT NOT NULL,
  date            TEXT NOT NULL,
  time            TEXT NOT NULL,
  party_size      INT  NOT NULL,
  payload         JSONB NOT NULL,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id, created_at DESC);

-- ─── 用户偏好（原 ~/.pi/agent/user-profiles/<userId>.json）──────────────
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id    TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 审计日志（T6 开始写入）──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id    TEXT,
  session_id TEXT,
  event_type TEXT NOT NULL,
  tool_name  TEXT,
  detail     JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);

-- ─── 用户账号（T3 NextAuth Credentials 使用）────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
