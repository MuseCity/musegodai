import { withDatabase } from "./database";
import { endIfTransferred, type MuseDeps } from "./muses";
import { rpcCauses } from "./rpc";
import type { MuseBindingRow } from "./schema";

export const sweepChunk = 10_000n,
  sweepMaxChunks = 12,
  sweepSafety = 64n;

class SweepFailure extends Error {
  constructor(
    readonly reason: "rpc" | "musegod_stale",
    cause?: unknown,
  ) {
    super("Muse sweep failed.", { cause });
  }
}

async function sweepRead<T>(
  reason: SweepFailure["reason"],
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new SweepFailure(reason, error);
  }
}

export async function sweepMuseTransfers(
  connectionString: string,
  deps: MuseDeps,
): Promise<{
  skipped: boolean;
  from: string | null;
  to: string | null;
  ended: number;
}> {
  const result = {
    skipped: false,
    from: null as string | null,
    to: null as string | null,
    ended: 0,
  };
  try {
    await withDatabase(connectionString, async (db) => {
      const head =
        (await sweepRead("rpc", () => deps.chain.headBlock())) - sweepSafety;
      if (head < 0n) return;
      const checkedDeps: MuseDeps = {
        ...deps,
        chain: {
          ...deps.chain,
          ownerOf: (tokenId) =>
            sweepRead("rpc", () => deps.chain.ownerOf(tokenId)),
        },
        wallets: {
          ...deps.wallets,
          linkedAddresses: async (userId) => {
            try {
              return await deps.wallets.linkedAddresses(userId);
            } catch {
              // This external ownership dependency is not a database failure;
              // only chain RPC errors may contribute RPC status/code fields.
              throw new SweepFailure("rpc");
            }
          },
        },
      };
      const check = async (bindings: MuseBindingRow[]) => {
        let ended = 0;
        for (const binding of bindings) {
          const record = await sweepRead("musegod_stale", () =>
            deps.musegod.muse(binding.token_id),
          );
          // A stale cache means the upstream check failed. Retry this range
          // later rather than checkpointing an incomplete ownership check.
          if (record.stale) throw new SweepFailure("musegod_stale");
          if (
            await endIfTransferred(
              db,
              checkedDeps,
              binding,
              record.value.agent.wallet,
            )
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
      for (let i = 0; i < sweepMaxChunks; i++) {
        const chunk = await db.transaction(async () => {
          const lock = await db.one<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock(624139189) AS locked",
          );
          if (!lock?.locked) return { skipped: true };
          // Re-read after locking every chunk: another run may have advanced
          // the shared checkpoint since this run's previous commit.
          const state = await db.one<{ last_block: string }>(
            "SELECT last_block FROM musecity.muse_sweep WHERE id='transfers' FOR UPDATE",
          );
          if (!state) {
            const bindings = await db.query<MuseBindingRow>(
              "SELECT * FROM musecity.muse_bindings WHERE ended_at IS NULL ORDER BY token_id",
            );
            const ended = await check(bindings);
            await save(head);
            return { from: null, to: head, ended, complete: true };
          }
          const last = BigInt(state.last_block);
          if (last >= head) return null;
          const from = last + 1n,
            to = last + sweepChunk < head ? last + sweepChunk : head;
          const tokens = await sweepRead("rpc", () =>
            deps.chain.transferredTokens(from, to),
          );
          const bindings = await db.query<MuseBindingRow>(
            "SELECT * FROM musecity.muse_bindings WHERE ended_at IS NULL AND token_id=ANY($1::integer[]) ORDER BY token_id",
            [tokens],
          );
          const ended = await check(bindings);
          await save(to);
          return { from, to, ended, complete: to === head };
        });
        if (!chunk) break;
        if ("skipped" in chunk) {
          result.skipped = true;
          break;
        }
        result.from ??= chunk.from?.toString() ?? null;
        result.to = chunk.to.toString();
        result.ended += chunk.ended;
        if (chunk.complete) break;
      }
    });
  } catch (error) {
    const reason = error instanceof SweepFailure ? error.reason : "database";
    const causes =
      error instanceof SweepFailure && reason === "rpc"
        ? rpcCauses(error.cause)
        : [];
    // Never log provider/database messages, URLs, stacks or raw causes.
    console.error(
      JSON.stringify({
        event: "muse.sweep.failed",
        reason,
        status: causes.find((cause) => cause.status !== undefined)?.status,
        code: causes.find((cause) => cause.code !== undefined)?.code,
      }),
    );
  }
  return result;
}
