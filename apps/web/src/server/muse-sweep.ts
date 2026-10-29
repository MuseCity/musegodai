import { withDatabase } from "./database";
import { endIfTransferred, type MuseDeps } from "./muses";
import type { MuseBindingRow } from "./schema";
class LookupFailure extends Error {
  constructor(readonly reason: "ownership" | "musegod" | "wallets") {
    super("Muse ownership lookup failed.");
  }
}
async function lookup<T>(
  reason: LookupFailure["reason"],
  operation: () => Promise<T>,
) {
  try {
    return await operation();
  } catch {
    throw new LookupFailure(reason);
  }
}
export async function sweepMuseTransfers(
  connectionString: string,
  deps: MuseDeps,
) {
  const result = { checked: 0, skipped: 0, ended: 0, failed: 0 };
  const failed = (reason: string, token: number | null) => {
    result.failed++;
    console.error(
      JSON.stringify({ event: "muse.sweep.failed", reason, token }),
    );
  };
  let nextReadAt = 0;
  try {
    await withDatabase(connectionString, async (db) => {
      const bindings = await db.query<MuseBindingRow>(
        "SELECT * FROM musecity.muse_bindings WHERE ended_at IS NULL ORDER BY token_id",
      );
      for (const snapshot of bindings) {
        try {
          const outcome = await db.transaction(async () => {
            const lock = await db.one<{ locked: boolean }>(
              "SELECT pg_try_advisory_xact_lock(624139189,$1) AS locked",
              [snapshot.token_id],
            );
            if (!lock?.locked) return "skip";
            const binding = await db.one<MuseBindingRow>(
              "SELECT * FROM musecity.muse_bindings WHERE id=$1 AND ended_at IS NULL",
              [snapshot.id],
            );
            if (!binding) return "skip";
            const delay = nextReadAt - Date.now();
            if (delay > 0)
              await new Promise((resolve) => setTimeout(resolve, delay));
            nextReadAt = Date.now() + 250;
            const owner = await lookup("ownership", () =>
              deps.ownership.ownerOf(binding.token_id),
            );
            const record = await lookup("musegod", () =>
              deps.musegod.muse(binding.token_id),
            );
            if (record.stale) throw new LookupFailure("musegod");
            const checkedDeps = {
              ...deps,
              wallets: {
                ...deps.wallets,
                linkedAddresses: (userId: string) =>
                  lookup("wallets", () => deps.wallets.linkedAddresses(userId)),
              },
            };
            return (await endIfTransferred(
              db,
              checkedDeps,
              binding,
              record.value.agent.wallet,
              owner,
            ))
              ? "ended"
              : "held";
          });
          if (outcome === "skip") result.skipped++;
          else {
            result.checked++;
            if (outcome === "ended") result.ended++;
          }
        } catch (error) {
          failed(
            error instanceof LookupFailure ? error.reason : "database",
            snapshot.token_id,
          );
        }
      }
    });
  } catch {
    failed("database", null);
  }
  return result;
}
