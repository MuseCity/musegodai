import { beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { openapi } from "../src/server/discovery";
import { withDatabase } from "../src/server/database";
import { publishScopes } from "../src/shared/contracts";
import { article, config, fixture, reset } from "./helpers";
import { withMuses } from "./muse-fakes";

const doc = openapi("http://localhost");
function validate(
  path: string,
  result: { status: number; data: unknown },
  method = "get",
) {
  expect(result.status).toBe(200);
  const schema = (doc.paths[path] as any)[method].responses[200].content[
    "application/json"
  ].schema;
  const validator = z.fromJSONSchema(
    JSON.parse(
      JSON.stringify({ ...schema, $defs: doc.components.schemas }).replaceAll(
        "#/components/schemas/",
        "#/$defs/",
      ),
    ),
  );
  const parsed = validator.safeParse(result.data);
  expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
}
beforeEach(reset);
it("validates bound muse setup, flock signatures and report contracts", async () => {
  const f = withMuses(fixture());
  const start = await f.call("/me/muses/1/start", { method: "POST" });
  const active = await f.call("/agent-connections", {
    method: "POST",
    token: null,
    body: { otp: start.data.otp },
  });
  const token = active.data.credential.token;
  validate("/agent/muse", await f.call("/agent/muse", { token }));
  validate(
    "/agent/muse/reports",
    await f.call("/agent/muse/reports", {
      method: "POST",
      token,
      body: { step: "soul", status: "done" },
    }),
    "post",
  );
  expect(
    (
      await f.call("/agent/muse/reports", {
        method: "POST",
        token,
        body: { step: "flock", status: "done", founding_number: 12 },
      })
    ).status,
  ).toBe(200);
  await withDatabase(config.testAdminUrl, (d) =>
    d.query(
      "INSERT INTO musecity.muse_signatures(id,binding_id,kind,place,line,signer,signature,state) SELECT 'contract-claim',id,'flock_claim','flock','fixed line',holder_address,'0x1234','handed_to_agent' FROM musecity.muse_bindings WHERE ended_at IS NULL",
    ),
  );
  const setup = await f.call("/agent/muse", { token });
  expect(setup.data.signatures).toHaveLength(1);
  validate("/agent/muse", setup);
  const operation = (doc.paths["/agent/muse/reports"] as any).post;
  expect(operation.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Idempotency-Key", required: true }),
    ]),
  );
  const schema = z.fromJSONSchema(
    operation.requestBody.content["application/json"].schema,
  );
  expect(schema.safeParse({ step: "look", status: "skipped" }).success).toBe(
    true,
  );
  for (const body of [
    { step: "hello", status: "done" },
    { step: "x", status: "needs_you", code: "arbitrary" },
    { step: "soul", status: "done", ownerAccountId: "forged" },
  ])
    expect(schema.safeParse(body).success).toBe(false);
});
it("validates empty/nonempty public directories, mixed search, discovery and scoped feedback responses", async () => {
  const f = fixture();
  validate("/neighbors", await f.call("/neighbors", { token: null }));
  validate(
    "/neighbors",
    await f.call("/neighbors?view=agents&q=no-match", { token: null }),
  );
  const owner = await f.call("/me", {
    method: "PATCH",
    body: { name: "Contract owner", bio: "", avatarMediaId: null, join: true },
  });
  validate("/neighbors", await f.call("/neighbors", { token: null }));
  const permissions = [
    ...publishScopes,
    "community:post",
    "community:notifications",
  ];
  const invitation = await f.call("/me/agent-invitations", {
    method: "POST",
    body: { name: "Contract Muse", scopes: permissions, confirmed: true },
  });
  const registration = await f.call("/agent-registrations", {
    token: null,
    method: "POST",
    body: {
      name: "Contract Muse",
      requestedScopes: permissions,
      invitationToken: invitation.data.invitationToken,
    },
  });
  const active = await f.call(
    `/agent-registrations/${registration.data.registrationId}/activate`,
    { token: registration.data.registrationToken, method: "POST" },
  );
  const token = active.data.credential.token;
  await f.call(`/me/agents/${active.data.agentId}`, {
    method: "PATCH",
    body: { confirmed: true, publicVisible: true },
  });
  validate(
    "/neighbors",
    await f.call("/neighbors?view=agents", { token: null }),
  );
  const draft = await f.call("/works", {
    token,
    method: "POST",
    body: { ...article, title: "Contract creation" },
  });
  await f.call(`/works/${draft.data.workId}/publish`, {
    token,
    method: "POST",
    body: { revisionId: draft.data.revisionId },
  });
  const post = await f.call("/posts", {
    token,
    method: "POST",
    body: { kind: "update", text: "Contract update" },
  });
  validate(
    "/posts/{id}",
    await f.call(`/posts/${post.data.id}`, { token: null }),
  );
  const feed = await f.call(
    `/feed?q=contract&owner=${owner.data.handle}&agent=${active.data.agentId}`,
    { token: null },
  );
  expect(feed.data.items).toHaveLength(2);
  validate("/feed", feed);
  await f.call(`/posts/${post.data.id}/comments`, {
    token: "fixture:bob",
    method: "POST",
    body: { text: "Contract comment" },
  });
  validate("/discovery", await f.call("/discovery", { token: null }));
  const inbox = await f.call("/agent/notifications", { token });
  validate("/agent/notifications", inbox);
  validate(
    "/agent/notifications/read",
    await f.call("/agent/notifications/read", {
      token,
      method: "POST",
      body: { ids: [inbox.data.items[0].id] },
    }),
    "post",
  );
  validate(
    "/agent/notifications",
    await f.call("/agent/notifications", { token }),
  );
});
