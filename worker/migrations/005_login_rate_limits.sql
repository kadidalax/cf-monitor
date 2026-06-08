-- 登录失败限速状态，用于 IP + username 维度的指数退避。

CREATE TABLE IF NOT EXISTS login_rate_limits (
    bucket TEXT PRIMARY KEY,
    failures INTEGER DEFAULT 0,
    first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL,
    locked_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_rate_limits_last_failed ON login_rate_limits(last_failed_at);
