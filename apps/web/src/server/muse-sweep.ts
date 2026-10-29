import { withDatabase } from "./database";
import { endIfTransferred, type MuseDeps } from "./muses";
import type { MuseBindingRow } from "./schema";

export const sweepChunk = 10_000n,
  sweepMaxChunks = 12,
  sweepSafety = 64n;

export async function sweepMuseTransfers(
  connectionString: string,
  deps: MuseDeps,
): Promise<{
  skipped: boolean;
  from: string | null;
  to: string | null;
  ended: number;
}> {
  return withDatabase(connectionString, async (db) => {
    const result = {
      skipped: false,
      from: null as string | null,
      to: null as string | null,
      ended: 0,
    };
    const lock = await db.one<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(624139189) AS locked",
    );
    if (!lock?.locked) return { ...result, skipped: true };
    try {
      const head = (await deps.chain.headBlock()) - sweepSafety;
      if (head < 0n) return result;
      const state = await db.one<{ last_block: string }>(
        "SELECT last_block FROM musecity.muse_sweep WHERE id='transfers'",
      );
      const check = async (bindings: MuseBindingRow[]) => {
        let ended = 0;
        for (const binding of bindings) {
          const record = await deps.musegod.muse(binding.token_id);
          // A stale cache means the upstream check failed. Retry this range
          // later rather than checkpointing an incomplete ownership check.
          if (record.stale) throw new Error("Muse snapshot is stale.");
          if (
            await endIfTransferred(db, deps, binding, record.value.agent.wallet)
          )
            ended++;
        }
        return ended;
      };
      const save = (block: bigint) =>
        db.query(
          "INSERT INTO musecity.muse_sweep(id,last_block) VALUES('transfers',$1) ON CONFLICT(id) DO UPDATE SET last_block=EXCLUDED.last_block,updated_at=now()",
          [block.toString()],
        );
      if (!state) {
        result.ended = await db.transaction(async () => {
          const bindings = await db.query<MuseBindingRow>(
            "SELECT * FROM musecity.muse_bindings WHERE ended_at IS NULL ORDER BY token_id",
          );
          const ended = await check(bindings);
          await save(head);
          return ended;
        });
        result.to = head.toString();
        return result;
      }
      let last = BigInt(state.last_block);
      for (let i = 0; i < sweepMaxChunks && last < head; i++) {
        const from = last + 1n,
          to = last + sweepChunk < head ? last + sweepChunk : head;
        const ended = await db.transaction(async () => {
          const tokens = await deps.chain.transferredTokens(from, to);
          const bindings = await db.query<MuseBindingRow>(
            "SELECT * FROM musecity.muse_bindings WHERE ended_at IS NULL AND token_id=ANY($1::integer[]) ORDER BY token_id",
            [tokens],
          );
          const ended = await check(bindings);
          await save(to);
          return ended;
        });
        result.from ??= from.toString();
        result.to = to.toString();
        result.ended += ended;
        last = to;
      }
    } catch {
      // RPC exceptions can carry a configured URL with an API key. Never log
      // their message, stack or cause; committed chunks remain resumable.
      console.error(JSON.stringify({ event: "muse.sweep.failed" }));
    } finally {
      await db.query("SELECT pg_advisory_unlock(624139189)");
    }
    return result;
  });
}
