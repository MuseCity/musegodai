-- Muse setup belongs to the keeper's account; Agent and public views derive from it.
CREATE TABLE musecity.muse_bindings (
 id text PRIMARY KEY,
 token_id integer NOT NULL CHECK (token_id BETWEEN 1 AND 999),
 agent_id_8004 integer NOT NULL,
 account_id text NOT NULL REFERENCES musecity.accounts(id) ON DELETE CASCADE,
 registration_id text REFERENCES musecity.registrations(id),
 agent_id text REFERENCES musecity.agents(id),
 holder_address text NOT NULL,
 description text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz,
 end_reason text CHECK (end_reason IN ('transferred','disconnected','restarted'))
);
CREATE UNIQUE INDEX muse_bindings_active ON musecity.muse_bindings(token_id) WHERE ended_at IS NULL;
CREATE INDEX muse_bindings_agent ON musecity.muse_bindings(agent_id);

CREATE TABLE musecity.muse_reports (
 binding_id text NOT NULL REFERENCES musecity.muse_bindings(id) ON DELETE CASCADE,
 step text NOT NULL CHECK (step IN ('soul','look','flock','musebook','terrakin','opensea','x')),
 status text NOT NULL CHECK (status IN ('done','needs_you','skipped')),
 url text,
 founding_number integer,
 wallet_address text,
 code text CHECK (code IN ('verification_code','opensea_link','approval')),
 reported_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (binding_id,step)
);

CREATE TABLE musecity.muse_signatures (
 id text PRIMARY KEY,
 binding_id text NOT NULL REFERENCES musecity.muse_bindings(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('lives_at','elsewhere','muse_link','flock_claim')),
 place text CHECK (place IN ('flock','musebook','terrakin','opensea','x','hiveverse')),
 line text NOT NULL,
 at integer,
 signer text NOT NULL,
 signature text NOT NULL,
 state text NOT NULL CHECK (state IN ('queued','sent','handed_to_agent','failed','expired','superseded')),
 attempts integer NOT NULL DEFAULT 0,
 sent_at timestamptz,
 result_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON musecity.muse_bindings FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON musecity.muse_bindings TO musecity_runtime;
REVOKE ALL ON musecity.muse_reports FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON musecity.muse_reports TO musecity_runtime;
REVOKE ALL ON musecity.muse_signatures FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON musecity.muse_signatures TO musecity_runtime;
