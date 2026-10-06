-- Private MCP authorization state; owner identity continues to come from Privy.
CREATE TABLE musecity.oauth_clients (
 id text PRIMARY KEY,
 name text NOT NULL,
 redirect_uris jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE musecity.oauth_requests (
 id text PRIMARY KEY,
 client_id text NOT NULL REFERENCES musecity.oauth_clients(id),
 redirect_uri text NOT NULL,
 state text,
 resource text NOT NULL,
 code_challenge text NOT NULL,
 requested_scopes jsonb NOT NULL,
 owner_account_id text REFERENCES musecity.accounts(id) ON DELETE CASCADE,
 name text,
 approved_scopes jsonb,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','exchanged')),
 code_hash text UNIQUE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE musecity.oauth_grants (
 id text PRIMARY KEY,
 client_id text NOT NULL REFERENCES musecity.oauth_clients(id),
 owner_account_id text NOT NULL REFERENCES musecity.accounts(id) ON DELETE CASCADE,
 agent_id text NOT NULL REFERENCES musecity.agents(id) ON DELETE CASCADE,
 resource text NOT NULL,
 scopes jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1,
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 connected_at timestamptz,
 UNIQUE (owner_account_id,client_id)
);
CREATE INDEX oauth_grants_agent ON musecity.oauth_grants(agent_id);
CREATE TABLE musecity.oauth_refresh_tokens (
 id text PRIMARY KEY,
 grant_id text NOT NULL REFERENCES musecity.oauth_grants(id) ON DELETE CASCADE,
 version integer NOT NULL,
 token_hash text NOT NULL UNIQUE,
 scopes jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 used_at timestamptz
);
ALTER TABLE musecity.credentials
 ADD COLUMN oauth_grant_id text REFERENCES musecity.oauth_grants(id) ON DELETE CASCADE,
 ADD COLUMN oauth_version integer,
 ADD COLUMN oauth_scopes jsonb;
ALTER TABLE musecity.credentials ADD CONSTRAINT credentials_oauth_binding CHECK (
 (oauth_grant_id IS NULL AND oauth_version IS NULL AND oauth_scopes IS NULL) OR
 (oauth_grant_id IS NOT NULL AND oauth_version IS NOT NULL AND oauth_scopes IS NOT NULL)
);
REVOKE ALL ON musecity.oauth_clients,musecity.oauth_requests,musecity.oauth_grants,musecity.oauth_refresh_tokens FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON musecity.oauth_clients,musecity.oauth_requests,musecity.oauth_grants,musecity.oauth_refresh_tokens TO musecity_runtime;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
  REVOKE ALL ON musecity.oauth_clients,musecity.oauth_requests,musecity.oauth_grants,musecity.oauth_refresh_tokens FROM anon;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
  REVOKE ALL ON musecity.oauth_clients,musecity.oauth_requests,musecity.oauth_grants,musecity.oauth_refresh_tokens FROM authenticated;
 END IF;
END $$;
