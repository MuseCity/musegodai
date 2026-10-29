import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sweepMuseTransfers } from "../src/server/muse-sweep";
import { withDatabase } from "../src/server/database";
import { ApiError } from "../src/server/errors";
import { ownershipUnavailableMessage } from "../src/server/opensea";
import { elsewhereLine } from "../src/shared/muses";
import { config, fixture, reset } from "./helpers";
import { addresses, withMuses } from "./muse-fakes";
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());
async function connect(f: ReturnType<typeof withMuses>) {
  const start = await f.call("/me/muses/1/start", { method: "POST" });
  expect(start.status).toBe(201);
  const active = await f.call("/agent-connections", {
    method: "POST",
    token: null,
    body: { otp: start.data.otp },
  });
  expect(active.status).toBe(201);
  return {
    id: active.data.agentId as string,
    token: active.data.credential.token as string,
  };
}
it("uses OpenSea's owner and never calls controller/binding RPCs, including delegates", async () => {
  const f = withMuses(fixture());
  f.linked.set("did:privy:alice", [addresses.delegate]);
  expect((await f.call("/me/muses/1")).status).toBe(403);
  f.linked.set("did:privy:alice", [addresses.external]);
  f.owners.set(1, addresses.external);
  expect((await f.call("/me/muses/1")).data.controllers).toEqual([
    addresses.external,
  ]);
  expect(Object.keys(f.chain)).toEqual(["verifyMessage"]);
});
it("retains the agent-wallet exception only for the bound account", async () => {
  const f = withMuses(fixture()),
    ag = await connect(f);
  f.setOwner(1, addresses.agent);
  expect((await f.call("/me/muses/1")).data.controllers).toEqual([]);
  expect(
    (
      await f.call("/agent/muse/reports", {
        method: "POST",
        token: ag.token,
        body: { step: "soul", status: "done" },
      })
    ).status,
  ).toBe(200);
  expect((await f.call("/me/muses/1", { token: "fixture:bob" })).status).toBe(
    403,
  );
});
it.each(["/muses/1", "/me/muses/1", "/agent/muse", "sweep"])(
  "transfer detection through %s commits Agent/credential/OAuth revocation and retains posts",
  async (path) => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    await withDatabase(config.testAdminUrl, async (d) => {
      const a = await d.one<{ owner_account_id: string }>(
        "SELECT owner_account_id FROM musecity.agents WHERE id=$1",
        [ag.id],
      );
      await d.query(
        "INSERT INTO musecity.oauth_clients(id,name,redirect_uris) VALUES('ownership-client','Local client','[]') ON CONFLICT DO NOTHING",
      );
      await d.query(
        "INSERT INTO musecity.oauth_grants(id,client_id,owner_account_id,agent_id,resource,scopes,expires_at) VALUES('ownership-grant','ownership-client',$1,$2,'http://localhost/mcp','[]',now()+interval '1 day')",
        [a!.owner_account_id, ag.id],
      );
      await d.query(
        "INSERT INTO musecity.registrations(id,name,requested_scopes,owner_account_id,token_hash,status,expires_at,agent_id) VALUES('ownership-pending','Pending','[]',$1,'local-pending-digest','approved',now()+interval '1 day',$2)",
        [a!.owner_account_id, ag.id],
      );
      await d.query(
        "INSERT INTO musecity.oauth_requests(id,client_id,redirect_uri,resource,code_challenge,requested_scopes,owner_account_id,status,expires_at) VALUES('ownership-request','ownership-client','http://localhost/callback','http://localhost/mcp','local-challenge','[]',$1,'approved',now()+interval '1 day')",
        [a!.owner_account_id],
      );
      await d.query(
        "INSERT INTO musecity.posts(id,owner_account_id,agent_id,kind,text) VALUES('ownership-post',$1,$2,'update','Historical muse post')",
        [a!.owner_account_id, ag.id],
      );
    });
    f.setOwner(1, addresses.stranger);
    expect((await f.call("/agent", { token: ag.token })).status).toBe(200);
    const response =
      path === "sweep"
        ? {
            status:
              (
                await sweepMuseTransfers(config.testUrl, {
                  musegod: f.musegod,
                  chain: f.chain,
                  ownership: f.ownership,
                  wallets: f.wallets,
                  origin: f.services.origin,
                })
              ).ended === 1
                ? 200
                : 503,
          }
        : await f.call(path, {
            token: path.startsWith("/agent")
              ? ag.token
              : path.startsWith("/me")
                ? "fixture:alice"
                : null,
          });
    expect(response.status).toBe(
      path.startsWith("/muses") || path === "sweep" ? 200 : 403,
    );
    expect(await f.call("/agent", { token: ag.token })).toMatchObject({
      status: 401,
      data: { error: { code: "CREDENTIAL_REVOKED" } },
    });
    await withDatabase(config.testAdminUrl, async (d) => {
      expect(
        (await d.one("SELECT status FROM musecity.agents WHERE id=$1", [ag.id]))
          ?.status,
      ).toBe("revoked");
      expect(
        (
          await d.one(
            "SELECT count(*)::int AS n FROM musecity.credentials WHERE agent_id=$1 AND revoked_at IS NULL",
            [ag.id],
          )
        )?.n,
      ).toBe(0);
      expect(
        (
          await d.one(
            "SELECT revoked_at FROM musecity.oauth_grants WHERE id='ownership-grant'",
          )
        )?.revoked_at,
      ).toBeInstanceOf(Date);
      expect(
        (
          await d.one(
            "SELECT end_reason FROM musecity.muse_bindings WHERE agent_id=$1",
            [ag.id],
          )
        )?.end_reason,
      ).toBe("transferred");
      expect(
        (
          await d.one(
            "SELECT status FROM musecity.registrations WHERE id='ownership-pending'",
          )
        )?.status,
      ).toBe("cancelled");
      expect(
        (
          await d.one(
            "SELECT status FROM musecity.oauth_requests WHERE id='ownership-request'",
          )
        )?.status,
      ).toBe("denied");
      expect(
        await d.one("SELECT id FROM musecity.posts WHERE id='ownership-post'"),
      ).toBeDefined();
      expect(
        await d.one(
          "SELECT id FROM musecity.activity WHERE resource_id=$1 AND action='agent.revoke'",
          [ag.id],
        ),
      ).toBeDefined();
    });
  },
);
it("authorization revokes a binding when its stored holder is no longer linked", async () => {
  const f = withMuses(fixture()),
    ag = await connect(f);
  f.linked.set("did:privy:alice", []);
  expect((await f.call("/me/muses/1")).status).toBe(403);
  expect((await f.call("/agent", { token: ag.token })).status).toBe(401);
});
it("fails ownership checks with the actionable ownership message", async () => {
  const f = withMuses(fixture());
  f.ownership.ownerOf.mockRejectedValue(
    new ApiError(503, "OWNERSHIP_UNAVAILABLE", ownershipUnavailableMessage),
  );
  expect(await f.call("/me/muses/1")).toMatchObject({
    status: 503,
    data: {
      error: {
        code: "OWNERSHIP_UNAVAILABLE",
        message: ownershipUnavailableMessage,
      },
    },
  });
});
it("accepts EOA signatures locally even when RPC verification is unavailable", async () => {
  const f = withMuses(fixture()),
    account = privateKeyToAccount(generatePrivateKey());
  f.setOwner(1, account.address.toLowerCase());
  f.linked.set("did:privy:alice", [account.address.toLowerCase()]);
  await connect(f);
  f.chain.verifyMessage.mockRejectedValue(new Error("Local RPC unavailable"));
  const at = Math.floor(Date.now() / 1000),
    line = elsewhereLine(1, "http://localhost/muses/1", at);
  const signature = await account.signMessage({ message: line });
  expect(
    (
      await f.call("/me/muses/1/signatures", {
        method: "POST",
        body: { kind: "elsewhere", at, signer: account.address, signature },
      })
    ).status,
  ).toBe(200);
  expect(f.chain.verifyMessage).not.toHaveBeenCalled();
});

it("commits a transfer discovered while the Agent view is being built", async () => {
  const f = withMuses(fixture()),
    ag = await connect(f);
  f.ownership.ownerOf
    .mockResolvedValueOnce(addresses.alice)
    .mockResolvedValue(addresses.stranger);
  expect((await f.call("/agent/muse", { token: ag.token })).status).toBe(403);
  expect((await f.call("/agent", { token: ag.token })).status).toBe(401);
});

it.each(["holder", "agent"] as const)(
  "public reads skip Privy when the cached owner matches the %s wallet",
  async (kind) => {
    const f = withMuses(fixture()),
      ag = await connect(f);
    const owner = kind === "holder" ? addresses.alice : addresses.agent;
    f.owners.set(1, "0x" + owner.slice(2).toUpperCase());
    f.wallets.linkedAddresses.mockClear();
    f.ownership.ownerOf.mockClear();
    const response = await f.call("/muses/1", { token: null });
    expect(response.status).toBe(200);
    expect(response.data.startedAt).not.toBeNull();
    expect(f.ownership.ownerOf).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.wallets.linkedAddresses).not.toHaveBeenCalled();
    await withDatabase(config.testAdminUrl, async (d) => {
      expect(
        (
          await d.one(
            "SELECT ended_at FROM musecity.muse_bindings WHERE agent_id=$1",
            [ag.id],
          )
        )?.ended_at,
      ).toBeNull();
      expect(
        (await d.one("SELECT status FROM musecity.agents WHERE id=$1", [ag.id]))
          ?.status,
      ).toBe("active");
    });
  },
);

it("public reads check Privy once for a changed owner and end and revoke a transferred binding", async () => {
  const f = withMuses(fixture()),
    ag = await connect(f);
  f.owners.set(1, addresses.stranger);
  f.wallets.linkedAddresses.mockClear();
  f.ownership.ownerOf.mockClear();
  const response = await f.call("/muses/1", { token: null });
  expect(response.status).toBe(200);
  expect(response.data.startedAt).toBeNull();
  expect(f.ownership.ownerOf).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.wallets.linkedAddresses).toHaveBeenCalledExactlyOnceWith(
    "did:privy:alice",
  );
  await withDatabase(config.testAdminUrl, async (d) => {
    expect(
      (
        await d.one(
          "SELECT end_reason FROM musecity.muse_bindings WHERE agent_id=$1",
          [ag.id],
        )
      )?.end_reason,
    ).toBe("transferred");
    expect(
      (await d.one("SELECT status FROM musecity.agents WHERE id=$1", [ag.id]))
        ?.status,
    ).toBe("revoked");
  });
  expect(await f.call("/agent", { token: ag.token })).toMatchObject({
    status: 401,
    data: { error: { code: "CREDENTIAL_REVOKED" } },
  });
});

it("public reads keep the binding and render 200 when ownership is unavailable", async () => {
  const f = withMuses(fixture()),
    ag = await connect(f);
  const binding = () =>
    withDatabase(config.testAdminUrl, (d) =>
      d.one("SELECT * FROM musecity.muse_bindings WHERE agent_id=$1", [ag.id]),
    );
  const before = await binding();
  f.ownership.ownerOf.mockRejectedValue(
    new ApiError(503, "OWNERSHIP_UNAVAILABLE", ownershipUnavailableMessage),
  );
  f.wallets.linkedAddresses.mockClear();
  const response = await f.call("/muses/1", { token: null });
  expect(response.status).toBe(200);
  expect(response.data.startedAt).toBe(before!.started_at.toISOString());
  expect(await binding()).toEqual(before);
  expect(f.wallets.linkedAddresses).not.toHaveBeenCalled();
  expect((await f.call("/agent", { token: ag.token })).status).toBe(200);
});

it("public reads retain a changed owner still linked to the binding's account after one Privy check", async () => {
  const f = withMuses(fixture()),
    ag = await connect(f);
  f.owners.set(1, addresses.external);
  f.wallets.linkedAddresses.mockClear();
  f.ownership.ownerOf.mockClear();
  const response = await f.call("/muses/1", { token: null });
  expect(response.status).toBe(200);
  expect(response.data.startedAt).not.toBeNull();
  expect(f.ownership.ownerOf).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.wallets.linkedAddresses).toHaveBeenCalledExactlyOnceWith(
    "did:privy:alice",
  );
  expect((await f.call("/agent", { token: ag.token })).status).toBe(200);
});
