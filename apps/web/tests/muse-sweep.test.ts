import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withDatabase } from "../src/server/database";
import { sweepMuseTransfers } from "../src/server/muse-sweep";
import { config, fixture, reset } from "./helpers";
import { addresses, withMuses } from "./muse-fakes";
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());
function setup() {
  const f = withMuses(fixture());
  return {
    ...f,
    deps: {
      musegod: f.musegod,
      chain: f.chain,
      ownership: f.ownership,
      wallets: f.wallets,
      origin: f.services.origin,
    },
  };
}
async function start(f: ReturnType<typeof setup>, id = 1) {
  f.setOwner(id, addresses.alice);
  expect(
    (await f.call("/me/muses/" + id + "/start", { method: "POST" })).status,
  ).toBe(201);
}
const run = (f: ReturnType<typeof setup>) =>
  sweepMuseTransfers(config.testUrl, f.deps);
const bindings = () =>
  withDatabase(config.testAdminUrl, (d) =>
    d.query(
      "SELECT token_id,ended_at,end_reason FROM musecity.muse_bindings ORDER BY token_id",
    ),
  );
it("checks all active bindings sequentially at no more than four ownership requests per second", async () => {
  const f = setup();
  for (const id of [1, 2, 3]) await start(f, id);
  const times: number[] = [];
  const owner = f.ownership.ownerOf.getMockImplementation()!;
  f.ownership.ownerOf.mockImplementation(async (id) => {
    times.push(Date.now());
    return owner(id);
  });
  expect(await run(f)).toEqual({ checked: 3, skipped: 0, ended: 0, failed: 0 });
  expect(times).toHaveLength(3);
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(250);
  expect(times[2] - times[1]).toBeGreaterThanOrEqual(250);
});
it("commits transfers independently, cancels pending codes and continues after an ownership failure without logging its message", async () => {
  const f = setup();
  for (const id of [1, 2, 3]) await start(f, id);
  for (const id of [1, 2, 3]) f.setOwner(id, addresses.stranger);
  const owner = f.ownership.ownerOf.getMockImplementation()!;
  f.ownership.ownerOf.mockImplementation(async (id) => {
    if (id === 2) throw new Error("PRIVATE_UPSTREAM_TEXT");
    return owner(id);
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await run(f)).toEqual({ checked: 2, skipped: 0, ended: 2, failed: 1 });
  expect((await bindings()).map((b) => b.end_reason)).toEqual([
    "transferred",
    null,
    "transferred",
  ]);
  expect(log.mock.calls).toEqual([
    [
      JSON.stringify({
        event: "muse.sweep.failed",
        reason: "ownership",
        token: 2,
      }),
    ],
  ]);
  await withDatabase(config.testAdminUrl, async (d) =>
    expect(
      (
        await d.query(
          "SELECT status FROM musecity.registrations ORDER BY created_at,id",
        )
      ).map((r) => r.status),
    ).toEqual(["cancelled", "approved", "cancelled"]),
  );
});
it.each([addresses.agent, addresses.external, addresses.alice])(
  "retains an active binding held by the account or its agent wallet %s",
  async (owner) => {
    const f = setup();
    await start(f);
    f.setOwner(1, owner);
    expect((await run(f)).ended).toBe(0);
    expect((await bindings())[0].ended_at).toBeNull();
  },
);
it("skips a token locked by another transaction while processing other bindings", async () => {
  const f = setup();
  await start(f);
  await start(f, 2);
  f.setOwner(2, addresses.stranger);
  await withDatabase(config.testAdminUrl, (d) =>
    d.transaction(async () => {
      await d.query("SELECT pg_advisory_xact_lock(624139189,1)");
      expect(await run(f)).toEqual({
        checked: 1,
        skipped: 1,
        ended: 1,
        failed: 0,
      });
    }),
  );
  expect(
    f.ownership.ownerOf.mock.calls.filter(([id]) => id === 1),
  ).toHaveLength(1); // start only
  expect((await run(f)).checked).toBe(1);
});
it("uses OpenSea despite an unchanged musegod owner hint", async () => {
  const f = setup();
  await start(f);
  f.owners.set(1, addresses.stranger);
  expect((await run(f)).ended).toBe(1);
});
it("does not retain the Transfer cursor table", async () => {
  await withDatabase(config.testAdminUrl, async (d) =>
    expect(
      (await d.one("SELECT to_regclass('musecity.muse_sweep') AS table_name"))
        ?.table_name,
    ).toBeNull(),
  );
});
