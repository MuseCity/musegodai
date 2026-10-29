import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertLocalTarget } from "../scripts/local-target";
import { Database, withDatabase } from "../src/server/database";
import { config } from "./helpers";

async function insertBinding(
  db: Database,
  prefix: string,
  suffix: string,
  tokenId = 1,
) {
  return db.query(
    `INSERT INTO musecity.muse_bindings
      (id,token_id,agent_id_8004,account_id,holder_address,description)
      VALUES($1,$2,6592,$3,$4,'muse #1 of MUSEGOD')`,
    [prefix + suffix, tokenId, prefix, "0x" + "12".repeat(20)],
  );
}

async function withBinding(
  run: (db: Database, prefix: string) => Promise<void>,
) {
  assertLocalTarget(config.testAdminUrl, "musecity_test", "musecity_admin");
  await withDatabase(config.testAdminUrl, async (db) => {
    const prefix = "muses-migration-" + randomUUID();
    await db.query("BEGIN");
    try {
      await db.query(
        "INSERT INTO musecity.accounts(id,privy_user_id,handle,name) VALUES($1,$1,$1,'Muse migration fixture')",
        [prefix],
      );
      await insertBinding(db, prefix, "-binding");
      await run(db, prefix);
    } finally {
      await db.query("ROLLBACK");
    }
  });
}

async function checkViolation(db: Database, run: () => Promise<unknown>) {
  await db.query("SAVEPOINT invalid_muse_value");
  await expect(run()).rejects.toMatchObject({ code: "23514" });
  await db.query("ROLLBACK TO SAVEPOINT invalid_muse_value");
}

describe("muse migration against real local PostgreSQL", () => {
  it("allows only one active binding per token and retains ended bindings", async () => {
    await withBinding(async (db, prefix) => {
      await db.query("SAVEPOINT duplicate_binding");
      await expect(insertBinding(db, prefix, "-second")).rejects.toMatchObject({
        code: "23505",
        constraint: "muse_bindings_active",
      });
      await db.query("ROLLBACK TO SAVEPOINT duplicate_binding");
      await db.query(
        "UPDATE musecity.muse_bindings SET ended_at=now(),end_reason='restarted' WHERE id=$1",
        [prefix + "-binding"],
      );
      await insertBinding(db, prefix, "-second");
      expect(
        await db.query(
          "SELECT id FROM musecity.muse_bindings WHERE token_id=1 AND ended_at IS NULL",
        ),
      ).toEqual([{ id: prefix + "-second" }]);
      expect(
        await db.one(
          "SELECT end_reason FROM musecity.muse_bindings WHERE id=$1",
          [prefix + "-binding"],
        ),
      ).toEqual({ end_reason: "restarted" });
    });
  });

  it("rejects token ids outside 1 through 999", async () => {
    await withBinding(async (db, prefix) => {
      for (const tokenId of [0, 1000])
        await checkViolation(db, () =>
          insertBinding(db, prefix, "-invalid", tokenId),
        );
      await insertBinding(db, prefix, "-last", 999);
    });
  });

  it("defaults new signature attempts and rejects the pending state", async () => {
    await withBinding(async (db, prefix) => {
      const row = await db.one(
        `INSERT INTO musecity.muse_signatures
          (id,binding_id,kind,place,line,at,signer,signature,state)
          VALUES($1,$2,'elsewhere',NULL,'Fixture line',1791000000,$3,'0x1234','queued')
          RETURNING attempts,created_at`,
        [prefix + "-signature", prefix + "-binding", "0x" + "34".repeat(20)],
      );
      expect(row?.attempts).toBe(0);
      expect(row?.created_at).toBeInstanceOf(Date);
      await checkViolation(db, () =>
        db.query(
          "UPDATE musecity.muse_signatures SET state='pending' WHERE id=$1",
          [prefix + "-signature"],
        ),
      );
      for (const state of [
        "queued",
        "sent",
        "handed_to_agent",
        "failed",
        "expired",
        "superseded",
      ])
        await db.query(
          "UPDATE musecity.muse_signatures SET state=$1 WHERE id=$2",
          [state, prefix + "-signature"],
        );
    });
  });

  it("limits reports to Agent-reportable steps, statuses and needs-you codes", async () => {
    await withBinding(async (db, prefix) => {
      for (const step of [
        "soul",
        "look",
        "flock",
        "musebook",
        "terrakin",
        "opensea",
        "x",
      ])
        await db.query(
          "INSERT INTO musecity.muse_reports(binding_id,step,status) VALUES($1,$2,'done')",
          [prefix + "-binding", step],
        );
      for (const step of ["movein", "hello", "hiveverse"])
        await checkViolation(db, () =>
          db.query(
            "INSERT INTO musecity.muse_reports(binding_id,step,status) VALUES($1,$2,'done')",
            [prefix + "-binding", step],
          ),
        );
      await checkViolation(db, () =>
        db.query(
          "UPDATE musecity.muse_reports SET status='half' WHERE binding_id=$1",
          [prefix + "-binding"],
        ),
      );
      await checkViolation(db, () =>
        db.query(
          "UPDATE musecity.muse_reports SET code='arbitrary request' WHERE binding_id=$1",
          [prefix + "-binding"],
        ),
      );
      await db.query(
        "UPDATE musecity.muse_reports SET status='skipped' WHERE binding_id=$1 AND step='look'",
        [prefix + "-binding"],
      );
      for (const code of ["verification_code", "opensea_link", "approval"])
        await db.query(
          "UPDATE musecity.muse_reports SET status='needs_you',code=$1 WHERE binding_id=$2 AND step='x'",
          [code, prefix + "-binding"],
        );
    });
  });

  it("grants only select, insert and update to runtime and nothing to PUBLIC", async () => {
    await withBinding(async (db) => {
      for (const table of [
        "muse_bindings",
        "muse_reports",
        "muse_signatures",
      ]) {
        expect(
          await db.query(
            "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='musecity' AND table_name=$1 AND grantee='musecity_runtime' ORDER BY privilege_type",
            [table],
          ),
        ).toEqual([
          { privilege_type: "INSERT" },
          { privilege_type: "SELECT" },
          { privilege_type: "UPDATE" },
        ]);
        expect(
          await db.query(
            "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='musecity' AND table_name=$1 AND grantee='PUBLIC'",
            [table],
          ),
        ).toEqual([]);
      }
    });
  });
});
