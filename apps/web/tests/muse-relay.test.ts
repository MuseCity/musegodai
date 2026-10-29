import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Database, withDatabase } from "../src/server/database";
import type { MuseDeps } from "../src/server/muses";
import type { MusegodServices } from "../src/server/musegod";
import type { MuseSignatureRow } from "../src/server/schema";
import {
  elsewhereLine,
  flockClaimLine,
  livesAtLine,
  museLinkLine,
  type MuseSignature,
} from "../src/shared/muses";
import { config, fixture, reset } from "./helpers";
import { withMuses } from "./muse-fakes";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());
const terrakin = "https://terrakin.org/r/r_0123456789abcdef";
const newerTerrakin = "https://terrakin.org/r/r_fedcba9876543210";
const now = () => Math.floor(Date.now() / 1000);
const controller = () => privateKeyToAccount(generatePrivateKey());
function setup() {
  const f = withMuses(fixture()),
    wallet = controller();
  const address = wallet.address.toLowerCase();
  f.setOwner(1, address);
  f.linked.set("did:privy:alice", [address]);
  const musegod = {
    ...f.musegod,
    postWorlds: vi
      .fn<MusegodServices["postWorlds"]>()
      .mockResolvedValue({ status: 200, code: null }),
  };
  f.services.musegod = musegod;
  const deps: MuseDeps = {
    musegod,
    chain: f.chain,
    ownership: f.ownership,
    wallets: f.wallets,
    origin: f.services.origin,
  };
  return { ...f, musegod, wallet, address, deps };
}
type Fixture = ReturnType<typeof setup>;
const drain = async (f: Fixture) =>
  (await import("../src/server/muse-relay")).relayPending(
    config.testUrl,
    f.deps,
  );
async function connect(f: Fixture) {
  const started = await f.call("/me/muses/1/start", { method: "POST" });
  expect(started.status).toBe(201);
  const active = await f.call("/agent-connections", {
    method: "POST",
    token: null,
    body: { otp: started.data.otp },
  });
  expect(active.status).toBe(201);
  const token = active.data.credential.token as string;
  expect((await f.call("/agent", { token })).status).toBe(200);
  return token;
}
async function report(f: Fixture, token: string, body: unknown) {
  const result = await f.call("/agent/muse/reports", {
    method: "POST",
    token,
    body,
  });
  expect(result.status).toBe(200);
}
const submit = (
  f: Fixture,
  body: MuseSignature,
  options: { token?: string; key?: string } = {},
) => f.call("/me/muses/1/signatures", { method: "POST", body, ...options });
async function signed(
  f: Fixture,
  kind: MuseSignature["kind"] = "lives_at",
  at = now(),
  url = terrakin,
): Promise<MuseSignature> {
  const line =
    kind === "lives_at"
      ? livesAtLine(1, "terrakin", url, at)
      : kind === "muse_link"
        ? museLinkLine(1, url, at)
        : kind === "elsewhere"
          ? elsewhereLine(1, `${f.services.origin}/muses/1`, at)
          : flockClaimLine(1, 12);
  return {
    kind,
    ...(kind === "elsewhere"
      ? {}
      : { place: kind === "flock_claim" ? "flock" : "terrakin" }),
    ...(kind === "flock_claim" ? {} : { at }),
    signer: f.wallet.address,
    signature: await f.wallet.signMessage({ message: line }),
  };
}
const rows = () =>
  withDatabase(config.testAdminUrl, (d) =>
    d.query<MuseSignatureRow>(
      "SELECT * FROM musecity.muse_signatures ORDER BY created_at,id",
    ),
  );
async function seed(f: Fixture, count = 1, at = now()) {
  const binding = await withDatabase(config.testAdminUrl, (d) =>
    d.one<{ id: string }>(
      "SELECT id FROM musecity.muse_bindings WHERE ended_at IS NULL",
    ),
  );
  for (let i = 0; i < count; i++) {
    const body = await signed(f, "elsewhere", at - i);
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "INSERT INTO musecity.muse_signatures(id,binding_id,kind,line,at,signer,signature,state,created_at) VALUES($1,$2,'elsewhere',$3,$4,$5,$6,'queued',now()+$7*interval '1 millisecond')",
        [
          `seed-${i}`,
          binding!.id,
          elsewhereLine(1, `${f.services.origin}/muses/1`, body.at!),
          body.at,
          body.signer,
          body.signature,
          i,
        ],
      ),
    );
  }
}

describe("keeper signatures and request-driven relay with isolated PostgreSQL", () => {
  it("signs and queues a pending Terrakin line, then relays its exact body", async () => {
    const f = setup(),
      token = await connect(f);
    await report(f, token, { step: "terrakin", status: "done", url: terrakin });
    const keeper = await f.call("/me/muses/1");
    const offered = keeper.data.needsYou.sign.find(
      (s: any) => s.kind === "lives_at",
    );
    const body = await signed(f, "lives_at", offered.at);
    expect(await submit(f, body)).toMatchObject({
      status: 200,
      data: { state: "queued" },
    });
    expect(f.ownership.ownerOf).toHaveBeenCalledWith(1);
    expect(await drain(f)).toEqual({ sent: 1, left: 0 });
    expect(f.musegod.postWorlds).toHaveBeenCalledExactlyOnceWith(1, {
      place: "terrakin",
      url: terrakin,
      at: body.at,
      signer: f.address,
      signature: body.signature,
    });
    expect((await rows())[0]).toMatchObject({ state: "sent", attempts: 0 });
  });

  it("accepts a line offered earlier using the submitted at, including the 600-second boundary", async () => {
    const f = setup(),
      token = await connect(f);
    await report(f, token, { step: "terrakin", status: "done", url: terrakin });
    const at = now(),
      body = await signed(f, "lives_at", at);
    vi.spyOn(Date, "now").mockReturnValue((at + 600) * 1000);
    expect(await submit(f, body)).toMatchObject({
      status: 200,
      data: { state: "queued" },
    });
  });

  it("refuses a kind/place the server did not offer", async () => {
    const f = setup();
    await connect(f);
    const body = await signed(f);
    body.place = "x";
    expect(await submit(f, body)).toMatchObject({
      status: 400,
      data: { error: { code: "LINE_NOT_PENDING" } },
    });
    const elsewhere = await signed(f, "elsewhere");
    elsewhere.place = "terrakin";
    expect(await submit(f, elsewhere)).toMatchObject({
      status: 400,
      data: { error: { code: "LINE_NOT_PENDING" } },
    });
  });

  it("refuses a linked non-controller and a tampered signature", async () => {
    const f = setup(),
      token = await connect(f);
    await report(f, token, { step: "terrakin", status: "done", url: terrakin });
    const stranger = controller();
    f.linked.get("did:privy:alice")!.push(stranger.address.toLowerCase());
    const body = await signed(f);
    expect(
      await submit(f, {
        ...body,
        signer: stranger.address,
        signature: await stranger.signMessage({
          message: livesAtLine(1, "terrakin", terrakin, body.at!),
        }),
      }),
    ).toMatchObject({
      status: 403,
      data: { error: { code: "NOT_MUSE_KEEPER" } },
    });
    expect(
      await submit(f, {
        ...body,
        signature: await f.wallet.signMessage({ message: "different text" }),
      }),
    ).toMatchObject({
      status: 403,
      data: { error: { code: "SIGNATURE_INVALID" } },
    });
    expect(await rows()).toHaveLength(0);
  });

  it("rejects timestamps older than 600 seconds, more than 30 seconds ahead, or missing", async () => {
    const f = setup();
    await connect(f);
    const clock = now();
    vi.spyOn(Date, "now").mockReturnValue(clock * 1000);
    for (const at of [clock - 601, clock + 31, clock + 600, clock + 601])
      expect(await submit(f, await signed(f, "elsewhere", at))).toMatchObject({
        status: 400,
        data: { error: { code: "SIGNATURE_EXPIRED" } },
      });
    const body = await signed(f, "elsewhere");
    delete body.at;
    expect(await submit(f, body)).toMatchObject({
      status: 400,
      data: { error: { code: "SIGNATURE_EXPIRED" } },
    });
  });

  it("accepts the 30-second future boundary for submission and relay", async () => {
    const f = setup();
    await connect(f);
    const clock = now();
    vi.spyOn(Date, "now").mockReturnValue(clock * 1000);
    expect(
      (await submit(f, await signed(f, "elsewhere", clock + 30))).status,
    ).toBe(200);
    expect(await drain(f)).toEqual({ sent: 1, left: 0 });
  });

  it("expires queued timestamps more than 30 seconds ahead without relaying", async () => {
    const f = setup();
    await connect(f);
    const clock = now();
    vi.spyOn(Date, "now").mockReturnValue(clock * 1000);
    await seed(f, 1, clock + 31);
    expect(await drain(f)).toEqual({ sent: 0, left: 0 });
    expect((await rows())[0].state).toBe("expired");
    expect(f.musegod.postWorlds).not.toHaveBeenCalled();
  });

  it("expires queued rows that age past the window and asks the keeper to sign again", async () => {
    const f = setup();
    await connect(f);
    const at = now();
    expect((await submit(f, await signed(f, "elsewhere", at))).status).toBe(
      200,
    );
    vi.spyOn(Date, "now").mockReturnValue((at + 601) * 1000);
    expect(await drain(f)).toEqual({ sent: 0, left: 0 });
    expect((await rows())[0].state).toBe("expired");
    expect((await f.call("/me/muses/1")).data.needsYou).toMatchObject({
      expired: 1,
      sign: [expect.objectContaining({ kind: "elsewhere" })],
    });
    expect(f.musegod.postWorlds).not.toHaveBeenCalled();
  });

  it("sends the oldest eight of ten rows and leaves two", async () => {
    const f = setup();
    await connect(f);
    await seed(f, 10);
    expect(await drain(f)).toEqual({ sent: 8, left: 2 });
    expect(f.musegod.postWorlds.mock.calls.map(([, b]) => b.at)).toEqual(
      (await rows()).slice(0, 8).map((r) => r.at),
    );
    expect((await rows()).filter((r) => r.state === "queued")).toHaveLength(2);
  });

  it("shares the eight-line budget across overlapping drains without duplicate sends", async () => {
    const f = setup();
    await connect(f);
    await seed(f, 10);
    const results = await Promise.all([drain(f), drain(f), drain(f)]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(8);
    expect(f.musegod.postWorlds).toHaveBeenCalledTimes(8);
    expect(
      new Set(f.musegod.postWorlds.mock.calls.map(([, b]) => b.signature)).size,
    ).toBe(8);
    expect((await rows()).filter((r) => r.state === "queued")).toHaveLength(2);
  });

  it("retries 429 and 503 once per invocation with identical bodies, then records success", async () => {
    const f = setup();
    await connect(f);
    const body = await signed(f, "elsewhere");
    expect((await submit(f, body)).status).toBe(200);
    f.musegod.postWorlds
      .mockResolvedValueOnce({ status: 429, code: "rate_limited" })
      .mockResolvedValueOnce({ status: 503, code: "retry" });
    for (const attempts of [1, 2]) {
      expect(await drain(f)).toEqual({ sent: 0, left: 1 });
      expect((await rows())[0]).toMatchObject({ state: "queued", attempts });
    }
    expect(await drain(f)).toEqual({ sent: 1, left: 0 });
    expect((await rows())[0]).toMatchObject({ state: "sent", attempts: 2 });
    const bodies = f.musegod.postWorlds.mock.calls.map(([, b]) => b);
    expect(bodies).toEqual(
      Array(3).fill({
        place: "elsewhere",
        url: `${f.services.origin}/muses/1`,
        at: body.at,
        signer: f.address,
        signature: body.signature,
      }),
    );
  });

  it("fails a forbidden relay permanently", async () => {
    const f = setup();
    await connect(f);
    await seed(f);
    f.musegod.postWorlds.mockResolvedValue({ status: 403, code: "forbidden" });
    expect(await drain(f)).toEqual({ sent: 0, left: 0 });
    expect((await rows())[0]).toMatchObject({
      state: "failed",
      result_code: "forbidden",
    });
    await drain(f);
    expect(f.musegod.postWorlds).toHaveBeenCalledTimes(1);
  });

  it("records an upstream 429 and stops before sending any further rows", async () => {
    const f = setup();
    await connect(f);
    await seed(f, 3);
    f.musegod.postWorlds.mockResolvedValueOnce({
      status: 429,
      code: "rate_limited",
    });
    expect(await drain(f)).toEqual({ sent: 0, left: 3 });
    expect(f.musegod.postWorlds).toHaveBeenCalledTimes(1);
    expect(
      (await rows()).map((r) => [r.state, r.attempts, r.result_code]),
    ).toEqual([
      ["queued", 1, "rate_limited"],
      ["queued", 0, null],
      ["queued", 0, null],
    ]);
    expect(await drain(f)).toEqual({ sent: 3, left: 0 });
  });

  it("commits earlier sends and their budget when a later SQL update is interrupted", async () => {
    const f = setup();
    await connect(f);
    await seed(f, 2);
    const query = Database.prototype.query;
    let updates = 0;
    vi.spyOn(Database.prototype, "query").mockImplementation(async function (
      this: Database,
      text: string,
      values?: unknown[],
    ) {
      if (
        /UPDATE musecity.muse_signatures SET state='sent'/.test(text) &&
        ++updates === 2
      )
        throw new Error("Test relay interruption.");
      return query.call(this, text, values);
    });
    await expect(drain(f)).rejects.toThrow("Test relay interruption.");
    expect((await rows()).map((r) => r.state)).toEqual(["sent", "queued"]);
    const budget = await withDatabase(config.testAdminUrl, (d) =>
      d.one<{ counter: number }>(
        "SELECT counter FROM musecity.rate_limits WHERE key=$1",
        ["musegod-relay:" + Math.floor(Date.now() / 60000)],
      ),
    );
    expect(budget?.counter).toBe(2);
    expect(await drain(f)).toEqual({ sent: 1, left: 0 });
    expect(
      f.musegod.postWorlds.mock.calls.filter(
        ([, body]) => body.at === f.musegod.postWorlds.mock.calls[0][1].at,
      ),
    ).toHaveLength(1);
  });

  it("keeps a durable budget charge when recording the current HTTP result fails", async () => {
    const f = setup();
    await connect(f);
    await seed(f);
    const query = Database.prototype.query;
    vi.spyOn(Database.prototype, "query").mockImplementation(async function (
      this: Database,
      text: string,
      values?: unknown[],
    ) {
      if (/UPDATE musecity.muse_signatures SET state='sent'/.test(text))
        throw new Error("Test SQL failure after HTTP.");
      return query.call(this, text, values);
    });
    await expect(drain(f)).rejects.toThrow("Test SQL failure after HTTP.");
    expect(f.musegod.postWorlds).toHaveBeenCalledTimes(1);
    const budget = await withDatabase(config.testAdminUrl, (d) =>
      d.one<{ counter: number }>(
        "SELECT counter FROM musecity.rate_limits WHERE key=$1",
        ["musegod-relay:" + Math.floor(Date.now() / 60000)],
      ),
    );
    expect(budget?.counter).toBe(1);
  });

  it("hands an untimestamped flock claim only to the bound Agent", async () => {
    const f = setup(),
      token = await connect(f);
    await report(f, token, {
      step: "flock",
      status: "done",
      founding_number: 12,
    });
    const body = await signed(f, "flock_claim");
    expect(await submit(f, { ...body, at: now() })).toMatchObject({
      status: 400,
      data: { error: { code: "LINE_NOT_PENDING" } },
    });
    expect(await submit(f, body)).toMatchObject({
      status: 200,
      data: { state: "handed_to_agent" },
    });
    expect((await f.call("/agent/muse", { token })).data.signatures).toEqual([
      {
        kind: "flock_claim",
        founding: 12,
        address: f.address,
        signature: body.signature,
      },
    ]);
    expect(await drain(f)).toEqual({ sent: 0, left: 0 });
    expect(f.musegod.postWorlds).not.toHaveBeenCalled();
    expect(f.musegod.postMuseLink).not.toHaveBeenCalled();
  });

  it("supersedes an old URL and asks for the new report without forwarding the old line", async () => {
    const f = setup(),
      token = await connect(f);
    await report(f, token, { step: "terrakin", status: "done", url: terrakin });
    expect((await submit(f, await signed(f))).status).toBe(200);
    await report(f, token, {
      step: "terrakin",
      status: "done",
      url: newerTerrakin,
    });
    expect((await rows())[0].state).toBe("superseded");
    expect(await drain(f)).toEqual({ sent: 0, left: 0 });
    expect((await f.call("/me/muses/1")).data.needsYou.sign).toContainEqual(
      expect.objectContaining({
        kind: "lives_at",
        line: expect.stringContaining(newerTerrakin),
      }),
    );
    expect(f.musegod.postWorlds).not.toHaveBeenCalled();
  });

  it("preserves place URLs, founding numbers and signatures on needs-you-only reports", async () => {
    const f = setup(),
      token = await connect(f);
    await report(f, token, { step: "terrakin", status: "done", url: terrakin });
    await report(f, token, {
      step: "flock",
      status: "done",
      founding_number: 12,
    });
    expect((await submit(f, await signed(f))).status).toBe(200);
    expect((await submit(f, await signed(f, "muse_link"))).status).toBe(200);
    expect((await submit(f, await signed(f, "flock_claim"))).status).toBe(200);
    for (const step of ["terrakin", "flock"])
      await report(f, token, { step, status: "needs_you", code: "approval" });
    const reports = await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "SELECT step,url,founding_number FROM musecity.muse_reports ORDER BY step",
      ),
    );
    expect(reports).toEqual([
      { step: "flock", url: null, founding_number: 12 },
      { step: "terrakin", url: terrakin, founding_number: null },
    ]);
    expect((await rows()).map((r) => r.state)).toEqual([
      "queued",
      "queued",
      "handed_to_agent",
    ]);
    expect(
      (await f.call("/agent/muse", { token })).data.signatures,
    ).toHaveLength(1);
    expect(await drain(f)).toEqual({ sent: 2, left: 0 });
  });

  it("reconstructs the latest report instead of substituting a stale signature's URL", async () => {
    const f = setup(),
      token = await connect(f);
    await report(f, token, { step: "terrakin", status: "done", url: terrakin });
    expect((await submit(f, await signed(f))).status).toBe(200);
    await withDatabase(config.testAdminUrl, (d) =>
      d.query("UPDATE musecity.muse_reports SET url=$1 WHERE step='terrakin'", [
        newerTerrakin,
      ]),
    );
    expect(await drain(f)).toEqual({ sent: 0, left: 0 });
    expect((await rows())[0].state).toBe("superseded");
    expect(f.musegod.postWorlds).not.toHaveBeenCalled();
  });

  it("relays the exact Terrakin muse-link endpoint payload", async () => {
    const f = setup(),
      token = await connect(f);
    await report(f, token, { step: "terrakin", status: "done", url: terrakin });
    const body = await signed(f, "muse_link");
    expect((await submit(f, body)).status).toBe(200);
    expect(await drain(f)).toEqual({ sent: 1, left: 0 });
    expect(f.musegod.postMuseLink).toHaveBeenCalledExactlyOnceWith({
      id: 1,
      endpoint: terrakin,
      at: body.at,
      signer: f.address,
      signature: body.signature,
    });
    expect(f.musegod.postWorlds).not.toHaveBeenCalled();
  });

  it("never forwards superseded, expired, failed or ended-binding rows", async () => {
    const f = setup();
    await connect(f);
    await seed(f, 4);
    await withDatabase(config.testAdminUrl, async (d) => {
      for (const [i, state] of ["superseded", "expired", "failed"].entries())
        await d.query(
          "UPDATE musecity.muse_signatures SET state=$2 WHERE id=$1",
          [`seed-${i}`, state],
        );
      await d.query(
        "UPDATE musecity.muse_bindings SET ended_at=now(),end_reason='transferred'",
      );
    });
    expect((await drain(f)).sent).toBe(0);
    expect(f.musegod.postWorlds).not.toHaveBeenCalled();
  });

  it("expires stale queued rows even after their binding has ended", async () => {
    const f = setup();
    await connect(f);
    await seed(f, 1, now() - 601);
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "UPDATE musecity.muse_bindings SET ended_at=now(),end_reason='transferred'",
      ),
    );
    expect(await drain(f)).toEqual({ sent: 0, left: 0 });
    expect((await rows())[0].state).toBe("expired");
    expect(f.musegod.postWorlds).not.toHaveBeenCalled();
    expect(f.musegod.postMuseLink).not.toHaveBeenCalled();
  });

  it("rechecks queued state after a candidate snapshot and a binding-lock wait", async () => {
    const f = setup();
    await connect(f);
    await seed(f, 3);
    let snapshot!: () => void;
    const observed = new Promise<void>((resolve) => {
      snapshot = resolve;
    });
    const query = Database.prototype.query;
    vi.spyOn(Database.prototype, "query").mockImplementation(async function (
      this: Database,
      text: string,
      values?: unknown[],
    ) {
      const result = await query.call(this, text, values);
      if (
        /SELECT/i.test(text) &&
        /muse_signatures/.test(text) &&
        /state='queued'/.test(text) &&
        /ORDER BY/.test(text)
      )
        snapshot();
      return result;
    });
    let running!: ReturnType<typeof drain>;
    await withDatabase(config.testAdminUrl, (d) =>
      d.transaction(async () => {
        await d.query("SELECT id FROM musecity.muse_bindings FOR UPDATE");
        running = drain(f);
        await Promise.race([
          observed,
          running.then(() => {
            throw new Error("Relay finished without a candidate snapshot.");
          }),
        ]);
        for (const [i, state] of ["superseded", "expired", "failed"].entries())
          await d.query(
            "UPDATE musecity.muse_signatures SET state=$2 WHERE id=$1",
            [`seed-${i}`, state],
          );
      }),
    );
    expect(await running).toEqual({ sent: 0, left: 0 });
    expect(f.musegod.postWorlds).not.toHaveBeenCalled();
  });

  it("checks a fresh wall clock after waiting for the shared rate-limit row", async () => {
    const f = setup();
    await connect(f);
    const at = now();
    await seed(f, 1, at);
    vi.spyOn(Date, "now").mockReturnValue(at * 1000);
    const query = Database.prototype.query;
    vi.spyOn(Database.prototype, "query").mockImplementation(async function (
      this: Database,
      text: string,
      values?: unknown[],
    ) {
      const result = await query.call(this, text, values);
      if (
        /INSERT INTO musecity.rate_limits/.test(text) &&
        String(values?.[0]).startsWith("musegod-relay:")
      )
        vi.mocked(Date.now).mockReturnValue((at + 601) * 1000);
      return result;
    });
    expect(await drain(f)).toEqual({ sent: 0, left: 0 });
    expect((await rows())[0].state).toBe("expired");
    expect(f.musegod.postWorlds).not.toHaveBeenCalled();
  });

  it("denies signatures before start, from another account or an Agent, including cached retries", async () => {
    const f = setup(),
      body = await signed(f, "elsewhere"),
      key = crypto.randomUUID();
    expect((await submit(f, body)).status).toBe(403);
    const token = await connect(f);
    expect((await submit(f, body, { token })).status).toBe(403);
    const bob = controller();
    f.linked.set("did:privy:bob", [bob.address.toLowerCase()]);
    expect(
      await submit(
        f,
        {
          ...body,
          signer: bob.address,
          signature: await bob.signMessage({
            message: elsewhereLine(1, `${f.services.origin}/muses/1`, body.at!),
          }),
        },
        { token: "fixture:bob" },
      ),
    ).toMatchObject({
      status: 403,
      data: { error: { code: "NOT_MUSE_KEEPER" } },
    });
    expect((await submit(f, body, { key })).status).toBe(200);
    expect((await submit(f, body, { key })).status).toBe(200);
    expect(await rows()).toHaveLength(1);
    f.owners.set(1, "0x5555555555555555555555555555555555555555");
    expect(await submit(f, body, { key })).toMatchObject({
      status: 403,
      data: { error: { code: "NOT_MUSE_KEEPER" } },
    });
  });

  it("schedules only successful authorized keeper reads and committed queued writes", async () => {
    const f = setup();
    await connect(f);
    const work: Promise<unknown>[] = [],
      committed: Promise<number>[] = [];
    let transactionCommitted = false;
    const transaction = Database.prototype.transaction;
    vi.spyOn(Database.prototype, "transaction").mockImplementation(
      async function (this: Database, fn) {
        const result = await transaction.call(this, fn);
        transactionCommitted = true;
        return result;
      },
    );
    f.services.waitUntil = (promise) => {
      expect(transactionCommitted).toBe(true);
      work.push(promise);
      committed.push(rows().then((list) => list.length));
    };
    expect((await f.call("/me/muses/1", { token: "fixture:bob" })).status).toBe(
      403,
    );
    expect((await f.call("/me/muses/1", { token: null })).status).toBe(401);
    expect(work).toHaveLength(0);
    expect((await submit(f, await signed(f))).status).toBe(400);
    expect(work).toHaveLength(0);
    expect((await f.call("/me/muses/1")).status).toBe(200);
    await Promise.all(work);
    work.length = 0;
    committed.length = 0;
    const body = await signed(f, "elsewhere"),
      key = crypto.randomUUID();
    transactionCommitted = false;
    expect((await submit(f, body, { key })).status).toBe(200);
    expect(work).toHaveLength(1);
    expect(await Promise.all(committed)).toEqual([1]);
    await Promise.all(work);
    work.length = 0;
    expect((await submit(f, body, { key })).status).toBe(200);
    expect(work).toHaveLength(0);
    expect((await rows())[0].state).toBe("sent");
  });
});
