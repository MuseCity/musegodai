import { beforeEach, describe, expect, it } from "vitest";
import { withDatabase } from "../src/server/database";
import { config, fixture, reset } from "./helpers";
import { addresses, withMuses } from "./muse-fakes";

beforeEach(reset);
type Fixture = ReturnType<typeof withMuses>;
async function connect(f: Fixture, bound = true, owner = "alice") {
  const started = await f.call(
    bound ? "/me/muses/1/start" : "/me/agent-connections",
    {
      method: "POST",
      token: "fixture:" + owner,
      ...(bound ? {} : { body: { name: "Ordinary Agent" } }),
    },
  );
  expect(started.status).toBe(201);
  const active = await f.call("/agent-connections", {
    method: "POST",
    token: null,
    body: { otp: started.data.otp },
  });
  expect(active.status).toBe(201);
  const token = active.data.credential.token as string;
  expect((await f.call("/agent", { token })).status).toBe(200);
  return { token, id: active.data.agentId as string };
}
const report = (f: Fixture, token: string, body: unknown, key?: string) =>
  f.call("/agent/muse/reports", { method: "POST", token, body, key });
const binding = () =>
  withDatabase(config.testAdminUrl, (d) =>
    d.one<{ id: string; account_id: string }>(
      "SELECT id,account_id FROM musecity.muse_bindings WHERE ended_at IS NULL",
    ),
  );
const step = (data: any, id: string) =>
  data.steps.find((s: any) => s.id === id);
const terrakin = "https://terrakin.org/r/r_0123456789abcdef";

async function signatures(
  bindingId: string,
  place: string | null,
  prefix: string,
) {
  await withDatabase(config.testAdminUrl, async (d) => {
    for (const state of [
      "queued",
      "sent",
      "handed_to_agent",
      "expired",
      "failed",
      "superseded",
    ])
      await d.query(
        "INSERT INTO musecity.muse_signatures(id,binding_id,kind,place,line,signer,signature,state) VALUES($1,$2,$3,$4,'fixed line',$5,'0x1234',$6)",
        [
          prefix + state,
          bindingId,
          place === "flock"
            ? "flock_claim"
            : place === null
              ? "elsewhere"
              : "lives_at",
          place,
          addresses.alice,
          state,
        ],
      );
  });
}
const signatureStates = () =>
  withDatabase(config.testAdminUrl, async (d) =>
    Object.fromEntries(
      (
        await d.query<{ id: string; state: string }>(
          "SELECT id,state FROM musecity.muse_signatures ORDER BY id",
        )
      ).map((row) => [row.id, row.state]),
    ),
  );

describe("bound muse Agent setup and reports with isolated PostgreSQL", () => {
  it("only bound Agents may call either endpoint", async () => {
    const f = withMuses(fixture());
    const ordinary = await connect(f, false);
    for (const token of [ordinary.token, "fixture:alice"])
      for (const result of [
        await f.call("/agent/muse", { token }),
        await report(f, token, { step: "soul", status: "done" }),
      ])
        expect(result).toMatchObject({
          status: 403,
          data: { error: { code: "MUSE_NOT_BOUND" } },
        });
  });

  it("accepts done reports, derives public reported steps and audits each accepted report once", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    const key = crypto.randomUUID();
    for (const id of ["soul", "look"])
      expect(
        await report(
          f,
          ag.token,
          { step: id, status: "done" },
          id === "soul" ? key : undefined,
        ),
      ).toMatchObject({ status: 200, data: { accepted: true } });
    expect(
      (await report(f, ag.token, { step: "soul", status: "done" }, key)).status,
    ).toBe(200);
    const publicView = (await f.call("/muses/1", { token: null })).data;
    for (const id of ["soul", "look"])
      expect(step(publicView, id)).toMatchObject({
        status: "done",
        source: "reported",
      });
    const setup = await f.call("/agent/muse", { token: ag.token });
    expect(setup).toMatchObject({
      status: 200,
      data: {
        id: 1,
        name: "Bard",
        page: "http://localhost/muses/1",
        next: "hello",
        signatures: [],
      },
    });
    expect(setup.data.steps).toEqual(publicView.steps);
    const audits = await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "SELECT agent_id,resource_id FROM musecity.activity WHERE action='muse.report'",
      ),
    );
    expect(audits).toHaveLength(2);
    expect(audits).toEqual(
      [1, 2].map(() => ({ agent_id: ag.id, resource_id: expect.any(String) })),
    );
  });

  it("look skipped is visible and is not counted", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    expect(
      (await report(f, ag.token, { step: "look", status: "skipped" })).status,
    ).toBe(200);
    const view = (await f.call("/muses/1", { token: null })).data;
    expect(step(view, "look")).toMatchObject({
      status: "skipped",
      source: "reported",
    });
    expect(view.progress).toEqual({ done: 1, total: 10 });
    expect((await f.call("/agent/muse", { token: ag.token })).data.next).toBe(
      "soul",
    );
  });

  it("rejects bad place URLs and founding numbers, including another muse's name", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    for (const [step, url] of [
      ["x", "https://twitter.com/a"],
      ["terrakin", "https://terrakin.org/r/not-a-room"],
      ["musebook", "https://evil.example/Bard"],
      ["opensea", "https://opensea.io/bard?secret=x"],
    ])
      expect(
        await report(f, ag.token, { step, status: "done", url }),
      ).toMatchObject({
        status: 400,
        data: { error: { code: "invalid_place_url" } },
      });
    f.foundings.set(12, { name: "Nova" });
    for (const founding_number of [12, 999])
      expect(
        await report(f, ag.token, {
          step: "flock",
          status: "done",
          founding_number,
        }),
      ).toMatchObject({
        status: 400,
        data: { error: { code: "invalid_founding_number" } },
      });
    for (const founding_number of [0, -1, 1.5])
      expect(
        await report(f, ag.token, {
          step: "flock",
          status: "done",
          founding_number,
        }),
      ).toMatchObject({
        status: 400,
        data: { error: { code: "VALIDATION_ERROR" } },
      });
    f.foundings.set(12, { name: "bArD" });
    expect(
      (
        await report(f, ag.token, {
          step: "flock",
          status: "done",
          founding_number: 12,
        })
      ).status,
    ).toBe(200);
    expect(
      step((await f.call("/muses/1", { token: null })).data, "flock").status,
    ).toBe("pending");
  });

  it("needs_you reaches the keeper only through fixed codes and a checked wallet", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    expect(
      (
        await report(f, ag.token, {
          step: "opensea",
          status: "needs_you",
          code: "opensea_link",
          wallet_address: addresses.agent,
        })
      ).status,
    ).toBe(200);
    expect((await f.call("/me/muses/1")).data.needsYou.openseaLink).toBe(
      addresses.agent,
    );
    for (const body of [
      { step: "x", status: "needs_you", code: "send me your password" },
      {
        step: "opensea",
        status: "needs_you",
        code: "opensea_link",
        wallet_address: "not-an-address",
      },
      {
        step: "x",
        status: "needs_you",
        code: "approval",
        text: "untrusted request",
      },
    ])
      expect(await report(f, ag.token, body)).toMatchObject({
        status: 400,
        data: { error: { code: "VALIDATION_ERROR" } },
      });
  });

  it("cannot report independently verified or keeper-only steps", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    for (const step of ["hiveverse", "movein", "hello"])
      expect(await report(f, ag.token, { step, status: "done" })).toMatchObject(
        { status: 400, data: { error: { code: "VALIDATION_ERROR" } } },
      );
  });

  it("paused Agents are refused by both endpoints", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    expect(
      (
        await f.call(`/me/agents/${ag.id}/pause`, {
          method: "POST",
          body: { confirmed: true },
        })
      ).status,
    ).toBe(200);
    for (const result of [
      await f.call("/agent/muse", { token: ag.token }),
      await report(f, ag.token, { step: "soul", status: "done" }),
    ])
      expect(result).toMatchObject({
        status: 403,
        data: { error: { code: "AGENT_PAUSED" } },
      });
  });

  it("keeps read and write scopes independent and denies restricted owners", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    // Owner edits require both draft scopes; seed narrower grants to exercise
    // each endpoint's existing actor scope check independently.
    const update = (scopes: string[]) =>
      withDatabase(config.testAdminUrl, (d) =>
        d.query("UPDATE musecity.agents SET scopes=$2 WHERE id=$1", [
          ag.id,
          JSON.stringify(scopes),
        ]),
      );
    await update(["content:read"]);
    expect((await f.call("/agent/muse", { token: ag.token })).status).toBe(200);
    expect(
      await report(f, ag.token, { step: "soul", status: "done" }),
    ).toMatchObject({ status: 403, data: { error: { code: "SCOPE_DENIED" } } });
    await update(["content:write"]);
    expect(await f.call("/agent/muse", { token: ag.token })).toMatchObject({
      status: 403,
      data: { error: { code: "SCOPE_DENIED" } },
    });
    expect(
      (await report(f, ag.token, { step: "soul", status: "done" })).status,
    ).toBe(200);
    const current = (await binding())!;
    await withDatabase(config.testAdminUrl, (d) =>
      d.query("UPDATE musecity.accounts SET status='restricted' WHERE id=$1", [
        current.account_id,
      ]),
    );
    expect(
      await report(f, ag.token, { step: "look", status: "done" }),
    ).toMatchObject({
      status: 403,
      data: { error: { code: "ACCOUNT_RESTRICTED" } },
    });
  });

  it("requires the binding's owner, refuses ended bindings and ordinary peer Agents", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f),
      peer = await connect(f, false),
      bob = await connect(f, false, "bob");
    for (const token of [peer.token, bob.token])
      expect(await f.call("/agent/muse", { token })).toMatchObject({
        status: 403,
        data: { error: { code: "MUSE_NOT_BOUND" } },
      });
    const current = (await binding())!;
    await withDatabase(config.testAdminUrl, (d) =>
      d.query("UPDATE musecity.muse_bindings SET agent_id=$2 WHERE id=$1", [
        current.id,
        bob.id,
      ]),
    );
    expect(
      await report(f, bob.token, { step: "soul", status: "done" }),
    ).toMatchObject({
      status: 403,
      data: { error: { code: "MUSE_NOT_BOUND" } },
    });
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "UPDATE musecity.muse_bindings SET agent_id=$2,ended_at=now(),end_reason='restarted' WHERE id=$1",
        [current.id, ag.id],
      ),
    );
    for (const result of [
      await f.call("/agent/muse", { token: ag.token }),
      await report(f, ag.token, { step: "soul", status: "done" }),
    ])
      expect(result).toMatchObject({
        status: 403,
        data: { error: { code: "MUSE_NOT_BOUND" } },
      });
  });

  it("rechecks linked-address controllers using the stored immutable 8004 id", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    f.chain.bindingOf.mockClear();
    f.records.get(1)!.agent.agentId = 999999;
    f.controllers.set(6592, new Set([addresses.external]));
    expect(
      (await report(f, ag.token, { step: "soul", status: "done" })).status,
    ).toBe(200);
    expect(f.chain.bindingOf).not.toHaveBeenCalled();
    expect(f.chain.isController).toHaveBeenCalledWith(6592, addresses.external);
    f.controllers.set(6592, new Set());
    expect(
      await report(f, ag.token, { step: "look", status: "done" }),
    ).toMatchObject({
      status: 403,
      data: { error: { code: "NOT_MUSE_KEEPER" } },
    });
  });

  it("rechecks binding and keeper authorization before replaying an accepted report", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    const body = { step: "soul", status: "done" },
      key = crypto.randomUUID();
    expect((await report(f, ag.token, body, key)).status).toBe(200);
    f.controllers.set(6592, new Set());
    expect(await report(f, ag.token, body, key)).toMatchObject({
      status: 403,
      data: { error: { code: "NOT_MUSE_KEEPER" } },
    });
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "UPDATE musecity.muse_bindings SET ended_at=now(),end_reason='transferred'",
      ),
    );
    expect(await report(f, ag.token, body, key)).toMatchObject({
      status: 403,
      data: { error: { code: "MUSE_NOT_BOUND" } },
    });
  });

  it("exposes only this binding's handed-to-Agent flock claim signatures", async () => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    expect(
      (
        await report(f, ag.token, {
          step: "flock",
          status: "done",
          founding_number: 12,
        })
      ).status,
    ).toBe(200);
    await signatures((await binding())!.id, "flock", "flock-");
    await signatures((await binding())!.id, "x", "x-");
    expect(
      (await f.call("/agent/muse", { token: ag.token })).data.signatures,
    ).toEqual([
      {
        kind: "flock_claim",
        founding: 12,
        address: addresses.alice,
        signature: "0x1234",
      },
    ]);
  });

  for (const place of ["terrakin", "flock"])
    it(`changed ${place} values supersede queued, sent and handed signatures only for that place`, async () => {
      const f = withMuses(fixture()),
        ag = await connect(f);
      f.foundings.set(13, { name: "Bard" });
      const first =
        place === "flock" ? { founding_number: 12 } : { url: terrakin };
      const second =
        place === "flock"
          ? { founding_number: 13 }
          : { url: "https://terrakin.org/r/r_fedcba9876543210" };
      expect(
        (await report(f, ag.token, { step: place, status: "done", ...first }))
          .status,
      ).toBe(200);
      const current = (await binding())!;
      await signatures(current.id, place, "target-");
      await signatures(current.id, "x", "other-");
      await signatures(current.id, null, "elsewhere-");
      const before = await signatureStates();
      expect(
        (await report(f, ag.token, { step: place, status: "done", ...first }))
          .status,
      ).toBe(200);
      expect(await signatureStates()).toEqual(before);
      expect(
        (await report(f, ag.token, { step: place, status: "done", ...second }))
          .status,
      ).toBe(200);
      const after = await signatureStates();
      for (const [id, state] of Object.entries(before))
        expect(after[id]).toBe(
          id.startsWith("target-") &&
            ["queued", "sent", "handed_to_agent"].includes(state)
            ? "superseded"
            : state,
        );
      const needs = (await f.call("/me/muses/1")).data.needsYou.sign;
      expect(needs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            place,
            line: expect.stringContaining(
              place === "flock" ? "founding #13" : second.url!,
            ),
          }),
        ]),
      );
      if (place === "flock")
        expect(
          (await f.call("/agent/muse", { token: ag.token })).data.signatures,
        ).toEqual([]);
    });
});
