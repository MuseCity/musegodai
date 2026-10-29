CREATE TABLE musecity.muse_sweep (
 id text PRIMARY KEY CHECK (id='transfers'),
 last_block bigint NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON musecity.muse_sweep FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON musecity.muse_sweep TO musecity_runtime;
