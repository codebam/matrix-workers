-- MSC4323 (stable since spec v1.18): standard account lock/suspend state
-- for server-local users. Locked accounts get 401 M_USER_LOCKED
-- (soft_logout) on everything but /logout{,/all}; suspended accounts get
-- 403 M_USER_SUSPENDED on the forbidden action set (join/knock/invite/
-- send/profile changes). Both are reversible and never touch credentials
-- or tokens: sessions stay intact so unlocking/unsuspending restores
-- access without a fresh login.
ALTER TABLE users ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
