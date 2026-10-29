import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { Database, withDatabase } from "../src/server/database";
import {
  sweepMuseTransfers,
  sweepChunk,
  sweepMaxChunks,
  sweepSafety,
} from "../src/server/muse-sweep";
import type { MuseDeps } from "../src/server/muses";
import { config, fixture, reset } from "./helpers";
import { addresses, withMuses } from "./muse-fakes";

beforeEach(async () => {
  await reset();
  await withDatabase(config.testAdminUrl, (d) =>
    d.query("DELETE FROM musecity.muse_sweep"),
  );
});
afterEach(() => vi.restoreAllMocks());
function setup(head = 10164n) {
  const f = withMuses(fixture());
  const chain = {
    ...f.chain,
    headBlock: vi.fn(async () => head),
    transferredTokens: vi.fn(
      async (_from: bigint, _to: bigint): Promise<number[]> => [1, 7],
    ),
  };
  const deps: MuseDeps = {
    chain,
    musegod: f.musegod,
    wallets: f.wallets,
    origin: f.services.origin,
  };
  return { ...f, chain, deps };
}
type Fixture = ReturnType<typeof setup>;
const run = (f: Fixture) => sweepMuseTransfers(config.testUrl, f.deps);
async function start(f: Fixture, id = 1) {
  f.setOwner(id, addresses.alice);
  f.controllers.set(6591 + id, new Set([addresses.alice]));
  expect(
    (await f.call(`/me/muses/${id}/start`, { method: "POST" })).status,
  ).toBe(201);
}
const state = () =>
  withDatabase(config.testAdminUrl, (d) =>
    d.one<{ last_block: string }>(
      "SELECT last_block FROM musecity.muse_sweep WHERE id='transfers'",
    ),
  );
const bindings = () =>
  withDatabase(config.testAdminUrl, (d) =>
    d.query<{
      token_id: number;
      ended_at: Date | null;
      end_reason: string | null;
    }>(
      "SELECT token_id,ended_at,end_reason FROM musecity.muse_bindings ORDER BY token_id",
    ),
  );
const checkpoint = (block = 100) =>
  withDatabase(config.testAdminUrl, (d) =>
    d.query(
      "INSERT INTO musecity.muse_sweep(id,last_block) VALUES('transfers',$1)",
      [block],
    ),
  );

describe("scheduled muse Transfer sweep with isolated PostgreSQL", () => {
  it("first run initializes and checks every active binding", async () => {
    const f = setup();
    await start(f);
    await start(f, 2);
    f.setOwner(2, addresses.stranger);
    expect(await run(f)).toEqual({
      skipped: false,
      from: null,
      to: "10100",
      ended: 1,
    });
    expect((await state())?.last_block).toBe("10100");
    expect(await bindings()).toEqual([
      { token_id: 1, ended_at: null, end_reason: null },
      { token_id: 2, ended_at: expect.any(Date), end_reason: "transferred" },
    ]);
    expect(f.chain.transferredTokens).not.toHaveBeenCalled();
    const cancelled = await withDatabase(config.testAdminUrl, (d) =>
      d.one<{ status: string }>(
        "SELECT r.status FROM musecity.registrations r JOIN musecity.muse_bindings b ON b.registration_id=r.id WHERE b.token_id=2",
      ),
    );
    expect(cancelled?.status).toBe("cancelled");
  });

  it("ends a transferred binding nobody visited and ignores unbound tokens", async () => {
    const f = setup();
    await start(f);
    await checkpoint();
    f.setOwner(1, addresses.stranger);
    expect(await run(f)).toEqual({
      skipped: false,
      from: "101",
      to: "10100",
      ended: 1,
    });
    expect(f.chain.transferredTokens).toHaveBeenCalledExactlyOnceWith(
      101n,
      10100n,
    );
    expect((await bindings())[0].end_reason).toBe("transferred");
    expect((await state())?.last_block).toBe("10100");
    expect(f.musegod.muse.mock.calls.map(([id]) => id)).not.toContain(7);
  });

  it.each([addresses.agent, addresses.external, addresses.alice])(
    "keeps ownership in the muse wallet or the keeper's wallets (%s)",
    async (owner) => {
      const f = setup();
      await start(f);
      await checkpoint();
      f.setOwner(1, owner);
      expect((await run(f)).ended).toBe(0);
      expect((await bindings())[0].ended_at).toBeNull();
    },
  );

  it("uses current ownerOf rather than the log recipient or upstream owner hint", async () => {
    const f = setup();
    await start(f);
    await checkpoint();
    f.owners.set(1, addresses.stranger); // upstream still reports Alice
    expect((await run(f)).ended).toBe(1);
  });

  it("chunks and caps a long backlog, then resumes the next range", async () => {
    const f = setup(200164n);
    await checkpoint();
    f.chain.transferredTokens.mockResolvedValue([]);
    expect([sweepChunk, sweepMaxChunks, sweepSafety]).toEqual([
      10000n,
      12,
      64n,
    ]);
    expect(await run(f)).toEqual({
      skipped: false,
      from: "101",
      to: "120100",
      ended: 0,
    });
    expect(f.chain.transferredTokens).toHaveBeenCalledTimes(12);
    expect(f.chain.transferredTokens).toHaveBeenNthCalledWith(
      12,
      110101n,
      120100n,
    );
    expect((await state())?.last_block).toBe("120100");
    expect(await run(f)).toEqual({
      skipped: false,
      from: "120101",
      to: "200100",
      ended: 0,
    });
    expect(f.chain.transferredTokens).toHaveBeenNthCalledWith(
      13,
      120101n,
      130100n,
    );
    expect((await state())?.last_block).toBe("200100");
  });

  it("retries the same range after a second-chunk failure without logging its URL", async () => {
    const f = setup(20164n);
    await checkpoint();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.chain.transferredTokens.mockResolvedValueOnce([]).mockRejectedValueOnce(
      new Error("https://rpc.example.test/fake-key", {
        cause: Object.assign(new Error("secret provider response"), {
          status: 503,
          code: "ECONNRESET",
        }),
      }),
    );
    await run(f);
    expect((await state())?.last_block).toBe("10100");
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "https://rpc.example.test/fake-key",
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "muse.sweep.failed",
        reason: "rpc",
        status: 503,
        code: "ECONNRESET",
      }),
    );
    f.chain.transferredTokens.mockResolvedValue([]);
    await run(f);
    expect(f.chain.transferredTokens).toHaveBeenNthCalledWith(
      3,
      10101n,
      20100n,
    );
    expect((await state())?.last_block).toBe("20100");
  });

  it.each(["rpc", "upstream", "stale"])(
    "rolls back binding changes and checkpoint on %s failure in a chunk",
    async (failure) => {
      const f = setup();
      await start(f);
      await start(f, 2);
      await checkpoint();
      f.setOwner(1, addresses.stranger);
      f.setOwner(2, addresses.stranger);
      f.chain.transferredTokens.mockResolvedValue([1, 2]);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      if (failure === "rpc")
        f.chain.ownerOf.mockRejectedValueOnce(new Error("offline"));
      else {
        const muse = f.musegod.muse.getMockImplementation()!;
        f.musegod.muse.mockImplementation(async (id) => {
          if (id !== 2) return muse(id);
          if (failure === "upstream") throw new Error("offline");
          return { ...(await muse(id)), stale: true };
        });
      }
      await run(f);
      expect((await state())?.last_block).toBe("100");
      expect((await bindings()).every((b) => b.ended_at === null)).toBe(true);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          event: "muse.sweep.failed",
          reason: failure === "rpc" ? "rpc" : "musegod_stale",
        }),
      );
    },
  );

  it.each(["rpc", "upstream", "stale"])(
    "does not initialize a checkpoint and logs the reason on %s failure",
    async (failure) => {
      const f = setup();
      await start(f);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      if (failure === "rpc")
        f.chain.ownerOf.mockRejectedValue(new Error("offline"));
      else if (failure === "upstream")
        f.musegod.muse.mockRejectedValue(new Error("secret upstream URL"));
      else {
        const muse = f.musegod.muse.getMockImplementation()!;
        f.musegod.muse.mockImplementation(async (id) => ({
          ...(await muse(id)),
          stale: true,
        }));
      }
      await run(f);
      expect(await state()).toBeUndefined();
      expect((await bindings())[0].ended_at).toBeNull();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          event: "muse.sweep.failed",
          reason: failure === "rpc" ? "rpc" : "musegod_stale",
        }),
      );
    },
  );

  it.each([
    { status: 429, code: -32005 },
    { status: "https://rpc.example.test/secret", code: "secret provider code" },
    { status: 999, code: Infinity },
  ])("logs only safe RPC head status/code (%j)", async (details) => {
    const f = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.chain.headBlock.mockRejectedValue(
      Object.assign(new Error("https://rpc.example.test/secret"), details),
    );
    expect(await run(f)).toEqual({
      skipped: false,
      from: null,
      to: null,
      ended: 0,
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "muse.sweep.failed",
        reason: "rpc",
        ...(details.status === 429 ? details : {}),
      }),
    );
    expect(await state()).toBeUndefined();
  });

  it.each([false, true])(
    "treats a failed linked-wallet ownership check as external, without RPC metadata (initialized=%s)",
    async (initialized) => {
      const f = setup();
      await start(f);
      if (initialized) await checkpoint();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      f.wallets.linkedAddresses.mockRejectedValue(
        Object.assign(new Error("https://privy.example.test/secret"), {
          status: 503,
          code: "ECONNRESET",
        }),
      );
      await run(f);
      expect((await state())?.last_block).toBe(initialized ? "100" : undefined);
      expect((await bindings())[0].ended_at).toBeNull();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({ event: "muse.sweep.failed", reason: "rpc" }),
      );
    },
  );

  it.each([false, true])(
    "logs database query failures and rolls back binding changes (initialized=%s)",
    async (initialized) => {
      const f = setup();
      await start(f);
      if (initialized) await checkpoint();
      f.setOwner(1, addresses.stranger);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const query = Database.prototype.query;
      vi.spyOn(Database.prototype, "query").mockImplementation(async function (
        this: Database,
        text,
        values,
      ) {
        if (text.startsWith("INSERT INTO musecity.muse_sweep"))
          throw Object.assign(new Error("postgres://secret-connection"), {
            status: 503,
            code: "ECONNRESET",
          });
        return query.call(this, text, values);
      });
      await run(f);
      expect((await state())?.last_block).toBe(initialized ? "100" : undefined);
      expect((await bindings())[0].ended_at).toBeNull();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({ event: "muse.sweep.failed", reason: "database" }),
      );
    },
  );

  it("does not leak database connection failures", async () => {
    const f = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(pg.Client.prototype, "connect").mockRejectedValueOnce(
      new Error("postgres://secret-connection"),
    );
    await expect(run(f)).resolves.toEqual({
      skipped: false,
      from: null,
      to: null,
      ended: 0,
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: "muse.sweep.failed", reason: "database" }),
    );
  });

  it("classifies a failed rollback as database even after an RPC failure", async () => {
    const f = setup();
    await checkpoint();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.chain.transferredTokens.mockRejectedValue(new Error("secret RPC URL"));
    const transaction = Database.prototype.transaction;
    vi.spyOn(Database.prototype, "transaction").mockImplementationOnce(
      async function <T>(this: Database, fn: () => Promise<T>): Promise<T> {
        const query = this.client.query.bind(this.client);
        const spy = vi.spyOn(this.client, "query");
        spy.mockImplementation((...args: Parameters<typeof query>) => {
          // Finish the real rollback before injecting its rejection so this
          // failure-path test leaves the isolated database clean.
          if (args[0] === "ROLLBACK")
            return query("ROLLBACK").then(() => {
              throw new Error("postgres://secret-rollback");
            });
          return query(...args);
        });
        return transaction.call(this, fn) as Promise<T>;
      },
    );
    await run(f);
    expect((await state())?.last_block).toBe("100");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: "muse.sweep.failed", reason: "database" }),
    );
  });

  it("rereads the shared checkpoint when another run commits between its chunks", async () => {
    const f = setup(30164n);
    await checkpoint();
    f.chain.transferredTokens.mockResolvedValue([]);
    const transaction = Database.prototype.transaction;
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>((r) => {
      entered = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    let paused = false;
    vi.spyOn(Database.prototype, "transaction").mockImplementation(
      async function <T>(this: Database, fn: () => Promise<T>): Promise<T> {
        const value = (await transaction.call(this, fn)) as T;
        if (!paused) {
          paused = true;
          entered();
          await blocked;
        }
        return value;
      },
    );
    const first = run(f);
    await observed;
    let second!: Awaited<ReturnType<typeof run>>,
      firstResult!: Awaited<ReturnType<typeof run>>;
    try {
      second = await sweepMuseTransfers(config.testUrl, {
        ...f.deps,
        chain: { ...f.chain, headBlock: async () => 20164n },
      });
    } finally {
      release();
      firstResult = await first;
    }
    expect(second).toEqual({
      skipped: false,
      from: "10101",
      to: "20100",
      ended: 0,
    });
    expect(firstResult).toEqual({
      skipped: false,
      from: "101",
      to: "30100",
      ended: 0,
    });
    expect(f.chain.transferredTokens.mock.calls).toEqual([
      [101n, 10100n],
      [10101n, 20100n],
      [20101n, 30100n],
    ]);
    expect((await state())?.last_block).toBe("30100");
  });

  it("allows only one first initialization while the checkpoint is absent", async () => {
    const f = setup();
    await start(f);
    const muse = f.musegod.muse.getMockImplementation()!;
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>((r) => {
      entered = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    f.musegod.muse.mockClear().mockImplementationOnce(async (id) => {
      entered();
      await blocked;
      return muse(id);
    });
    const first = run(f);
    await observed;
    try {
      expect(await run(f)).toEqual({
        skipped: true,
        from: null,
        to: null,
        ended: 0,
      });
      expect(f.musegod.muse).toHaveBeenCalledTimes(1);
      expect(await state()).toBeUndefined();
    } finally {
      release();
      await first;
    }
    expect((await state())?.last_block).toBe("10100");
  });

  it("never runs twice at once and releases the lock after finishing", async () => {
    const f = setup();
    await checkpoint();
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>((r) => {
      entered = r;
    });
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    f.chain.transferredTokens.mockImplementationOnce(async () => {
      entered();
      await blocked;
      return [];
    });
    const first = run(f);
    await observed;
    try {
      expect(await run(f)).toEqual({
        skipped: true,
        from: null,
        to: null,
        ended: 0,
      });
      expect(f.chain.transferredTokens).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
    expect((await run(f)).skipped).toBe(false);
  });

  it("does nothing when there is no new safe block", async () => {
    const f = setup(164n);
    await checkpoint();
    expect(await run(f)).toEqual({
      skipped: false,
      from: null,
      to: null,
      ended: 0,
    });
    expect(f.chain.transferredTokens).not.toHaveBeenCalled();
    expect((await state())?.last_block).toBe("100");
  });
});
