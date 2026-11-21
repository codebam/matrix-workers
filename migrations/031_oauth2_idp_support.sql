-- Generic OAuth 2.0 external IdP support (GitHub first).
-- OAuth2 providers have no OIDC discovery document or JWKS, so they carry their
-- endpoints directly on the provider row. The defaults preserve OIDC behavior:
-- existing OIDC providers keep provider_type='oidc' and ignore these columns.
ALTER TABLE idp_providers ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'oidc';
ALTER TABLE idp_providers ADD COLUMN authorization_endpoint TEXT;
ALTER TABLE idp_providers ADD COLUMN token_endpoint TEXT;
ALTER TABLE idp_providers ADD COLUMN userinfo_endpoint TEXT;
ALTER TABLE idp_providers ADD COLUMN emails_endpoint TEXT;
