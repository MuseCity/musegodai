import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  draftScopes,
  publishScopes,
  scopes,
  type Scope,
} from "../src/shared/contracts";
import { article, fixture, reset } from "./helpers";

const clients: Client[] = [];
beforeEach(reset);
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
async function activate(
  f: ReturnType<typeof fixture>,
  permissions: Scope[] = draftScopes,
  owner = "alice",
) {
  const invitation = await f.call("/me/agent-invitations", {
    token: "fixture:" + owner,
    method: "POST",
    body: { name: "MCP assistant", scopes: permissions, confirmed: true },
  });
  expect(invitation.status).toBe(201);
  const registration = await f.call("/agent-registrations", {
    token: null,
    method: "POST",
    body: {
      name: "MCP assistant",
      requestedScopes: permissions,
      invitationToken: invitation.data.invitationToken,
    },
  });
  const active = await f.call(
    "/agent-registrations/" + registration.data.registrationId + "/activate",
    {
      token: registration.data.registrationToken,
      method: "POST",
    },
  );
  expect(active.status).toBe(201);
  return {
    id: active.data.agentId as string,
    token: active.data.credential.token as string,
  };
}
async function connect(
  f: ReturnType<typeof fixture>,
  token: string,
  modern = false,
) {
  const client = new Client(
    { name: "musecity-local-acceptance", version: "1.0.0" },
    {
      versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
    },
  );
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
      fetch: async (url, init) => f.app.fetch(new Request(url, init)),
    }),
  );
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((part) => part.type === "text");
  if (!text || text.type !== "text") throw new Error("Missing tool result");
  return { response, data: JSON.parse(text.text) };
}
async function control(
  f: ReturnType<typeof fixture>,
  id: string,
  action: string,
) {
  expect(
    (
      await f.call(`/me/agents/${id}/${action}`, {
        method: "POST",
        body: { confirmed: true },
      })
    ).status,
  ).toBe(200);
}

describe("MCP over Streamable HTTP with the real local PostgreSQL API", () => {
  it("shares website markers and verification with REST under publishing permissions", async () => {
    const f = fixture(),
      ag = await activate(f, publishScopes),
      client = await connect(f, ag.token);
    let checks = 0;
    f.services.verifyWebsite = async (input) => {
      checks++;
      const { marker: _, ...subject } = input.subjects[0];
      return {
        status: "verified",
        reason: null,
        subject,
        finalUrl: input.url,
        checkedAt: new Date().toISOString(),
      };
    };
    const identity = await call(client, "get_agent");
    expect(identity.data.websiteMarker).toMatch(/^mc_a_/);
    const creation = await call(client, "create_creation", {
      content: {
        type: "website",
        title: "My MCP website",
        description: "",
        aiTools: [],
        tagIds: [],
        websiteUrl: "https://creator.example.com",
      },
      idempotencyKey: crypto.randomUUID(),
    });
    const args = {
      id: creation.data.workId,
      revisionId: creation.data.revisionId,
      idempotencyKey: crypto.randomUUID(),
    };
    const verified = await call(client, "verify_creation_originality", args);
    expect(verified.data.httpStatus).toBe(200);
    expect(verified.data.work.originality.subject.id).toBe(ag.id);
    expect(verified.data.work.status).toBe("draft");
    expect(
      (await call(client, "verify_creation_originality", args)).data.work
        .originality,
    ).toEqual(verified.data.work.originality);
    expect(checks).toBe(1);
    expect(
      (
        await client.callTool({
          name: "verify_creation_originality",
          arguments: { ...args, url: "https://other.example.com" },
        })
      ).isError,
    ).toBe(true);
    const denied = await activate(f),
      deniedClient = await connect(f, denied.token);
    expect(
      (await call(deniedClient, "verify_creation_originality", args)).data
        .httpStatus,
    ).toBe(403);
    const openapi: any = await (
      await f.app.request("http://localhost/openapi.json")
    ).json();
    expect(
      openapi.paths["/works/{id}/verify-originality"].post.requestBody.content[
        "application/json"
      ].schema.additionalProperties,
    ).toBe(false);
    expect(openapi.components.schemas.WorkView.properties).toHaveProperty(
      "originality",
    );
    expect(
      openapi.components.schemas.WorkContent.properties,
    ).not.toHaveProperty("originality");
    expect(openapi.components.schemas.Profile.properties).not.toHaveProperty(
      "websiteMarker",
    );
  });
  it("handles scoped Agent feedback end-to-end without granting replies", async () => {
    const f = fixture(),
      ag = await activate(f, [
        ...draftScopes,
        "community:post",
        "community:notifications",
      ]),
      client = await connect(f, ag.token);
    const created = await call(client, "create_post", {
      content: { kind: "update", text: "MCP feedback workflow" },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(created.data.httpStatus).toBe(201);
    const comment = await f.call(`/posts/${created.data.id}/comments`, {
      token: "fixture:bob",
      method: "POST",
      body: { text: "A human's useful feedback" },
    });
    expect(comment.status).toBe(201);
    const inbox = await call(client, "list_agent_notifications");
    expect(inbox.data.httpStatus).toBe(200);
    expect(inbox.data.unread).toBe(1);
    expect(inbox.data.items[0].commentId).toBe(comment.data.id);
    expect((await call(client, "list_agent_notifications")).data.unread).toBe(
      1,
    );
    const context = await call(client, "list_comments", {
      kind: "post",
      id: created.data.id,
      focus: comment.data.id,
    });
    expect(context.data.items.map((c: { id: string }) => c.id)).toContain(
      comment.data.id,
    );
    expect(
      (
        await call(client, "reply", {
          kind: "post",
          id: created.data.id,
          text: "Not authorized",
          idempotencyKey: crypto.randomUUID(),
        })
      ).data.httpStatus,
    ).toBe(403);
    const args = {
      ids: [inbox.data.items[0].id],
      idempotencyKey: crypto.randomUUID(),
    };
    expect(
      (await call(client, "mark_agent_notifications_read", args)).data.read,
    ).toBe(true);
    expect(
      (await call(client, "mark_agent_notifications_read", args)).data.read,
    ).toBe(true);
    expect((await call(client, "list_agent_notifications")).data.unread).toBe(
      0,
    );
    expect(
      (await call(client, "list_agent_notifications", { unread: false })).data
        .items,
    ).toHaveLength(1);
    const other = await activate(f),
      otherClient = await connect(f, other.token);
    expect(
      (await call(otherClient, "list_agent_notifications")).data.httpStatus,
    ).toBe(403);
  });

  for (const modern of [false, true])
    it(`connects a ${modern ? "2026" : "2025"} SDK client and discovers usable tools and resources`, async () => {
      const f = fixture();
      const agent = await activate(f);
      const client = await connect(f, agent.token, modern);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "list_feed",
          "list_neighbors",
          "list_discovery",
          "list_agent_notifications",
          "mark_agent_notifications_read",
        ]),
      );
      expect(tools.tools.map((t) => t.name)).toContain("create_creation");
      const feedTool = tools.tools.find((tool) => tool.name === "list_feed")!;
      expect(feedTool.inputSchema.properties).toHaveProperty("q");
      expect(feedTool.inputSchema.properties).toHaveProperty("agent");
      expect(feedTool.inputSchema.properties).not.toHaveProperty("help");
      expect(
        (await call(client, "list_feed", { q: "设计 React" })).data.httpStatus,
      ).toBe(200);
      expect(
        (await call(client, "list_neighbors", { view: "agents" })).data
          .httpStatus,
      ).toBe(200);
      expect((await call(client, "list_discovery")).data.httpStatus).toBe(200);
      for (const args of [{ kind: "help" }, { help: "open" }])
        expect(
          (await client.callTool({ name: "list_feed", arguments: args }))
            .isError,
        ).toBe(true);
      expect(
        tools.tools.find((tool) => tool.name === "list_comments")!.inputSchema
          .properties,
      ).toHaveProperty("focus");
      const sites = await call(client, "list_feed", { view: "sites" });
      expect(sites.data.httpStatus).toBe(200);
      expect(sites.response.isError).not.toBe(true);
      for (const builder of ["codex", "claude", "muse"]) {
        expect(
          (await call(client, "list_feed", { view: "sites", builder })).data
            .httpStatus,
        ).toBe(200);
      }
      expect(
        (await call(client, "list_feed", { builder: "codex" })).data.httpStatus,
      ).toBe(400);
      expect(
        (
          await client.callTool({
            name: "list_feed",
            arguments: { view: "sites", builder: "unknown" },
          })
        ).isError,
      ).toBe(true);
      for (const name of ["list_feed", "list_neighbors"]) {
        const tool = tools.tools.find((t) => t.name === name)!;
        expect(tool.inputSchema.properties).not.toHaveProperty("ecosystem");
        expect((await call(client, name)).data.httpStatus).toBe(200);
        const invalid = await client.callTool({
          name,
          arguments: { ecosystem: "base" },
        });
        expect(invalid.isError).toBe(true);
      }
      expect(tools.tools.map((t) => t.name)).not.toEqual(
        expect.arrayContaining(["delete_creation", "manage_agent", "request"]),
      );
      expect(JSON.stringify(tools)).not.toContain(agent.token);
      const identity = await call(client, "get_agent");
      expect(identity.data).toMatchObject({
        id: agent.id,
        status: "active",
        scopes: draftScopes,
      });
      expect((await call(client, "list_tags")).data.tags).toHaveLength(6);
      const resources = await client.listResources();
      expect(resources.resources.map((r) => r.uri)).toEqual([
        "http://localhost/skill.md",
        "http://localhost/openapi.json",
      ]);
      const guide = await client.readResource({
        uri: "http://localhost/skill.md",
      });
      expect(guide.contents[0]).toHaveProperty(
        "text",
        expect.stringContaining("/mcp"),
      );
      const schema = await client.readResource({
        uri: "http://localhost/openapi.json",
      });
      expect(schema.contents[0]).toHaveProperty(
        "text",
        expect.stringContaining('"openapi":"3.1.0"'),
      );
    });

  it("publishes to another account's shared tag while denying Agent catalog management", async () => {
    const f = fixture();
    const tag = (
      await f.call("/tags", {
        method: "POST",
        token: "fixture:bob",
        body: { name: "Music" },
      })
    ).data;
    const agent = await activate(f, [...draftScopes, "community:post"]);
    expect(
      (
        await f.call("/tags", {
          token: agent.token,
          method: "POST",
          body: { name: "Agent tag" },
        })
      ).status,
    ).toBe(403);
    const client = await connect(f, agent.token);
    const post = await call(client, "create_post", {
      content: {
        kind: "update",
        text: "A shared composition",
        tagIds: [tag.id],
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(post.data.tagIds).toEqual([tag.id]);
    expect(post.data.agent.id).toBe(agent.id);
    const feed = await call(client, "list_feed", { tag: tag.id });
    expect(feed.data.items.map((v: { id: string }) => v.id)).toEqual([
      post.data.id,
    ]);
    const denied = await activate(f, draftScopes, "bob");
    const deniedClient = await connect(f, denied.token);
    expect(
      (
        await call(deniedClient, "create_post", {
          content: { kind: "update", text: "No permission", tagIds: [tag.id] },
          idempotencyKey: crypto.randomUUID(),
        })
      ).data.error.code,
    ).toBe("SCOPE_DENIED");
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
      "create_tag",
    );
  });

  it("creates, reads and edits a private draft with REST-shared idempotency and publication permissions", async () => {
    const f = fixture();
    const agent = await activate(f);
    const client = await connect(f, agent.token);
    const args = { content: article, idempotencyKey: crypto.randomUUID() };
    const created = await call(client, "create_creation", args);
    expect(created.data).toMatchObject({
      status: "draft",
      submittedBy: { id: agent.id },
    });
    const id = created.data.workId;
    expect(
      (await call(client, "get_creation", { id, draft: true })).data.workId,
    ).toBe(id);
    expect((await f.call(`/works/${id}`, { token: null })).status).toBe(404);
    expect(
      (await call(client, "list_my_creations")).data.items.map(
        (w: { workId: string }) => w.workId,
      ),
    ).toEqual([id]);
    expect((await call(client, "create_creation", args)).data.workId).toBe(id);
    expect(
      (
        await f.call("/works", {
          token: agent.token,
          method: "POST",
          body: article,
          key: args.idempotencyKey,
        })
      ).data.workId,
    ).toBe(id);
    expect(
      (
        await call(client, "create_creation", {
          ...args,
          content: { ...article, title: "Different" },
        })
      ).data.error.code,
    ).toBe("IDEMPOTENCY_CONFLICT");
    const publication = await call(client, "publish_creation", {
      id,
      revisionId: created.data.revisionId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(publication.response.isError).toBe(true);
    expect(publication.data.error.code).toBe("SCOPE_DENIED");
    const editArgs = {
      id,
      baseRevisionId: created.data.revisionId,
      content: { ...article, title: "Updated" },
      idempotencyKey: crypto.randomUUID(),
    };
    expect(
      (await call(client, "edit_creation", editArgs)).data.body.title,
    ).toBe("Updated");
    expect(
      (
        await call(client, "edit_creation", {
          ...editArgs,
          idempotencyKey: crypto.randomUUID(),
        })
      ).data.error.code,
    ).toBe("REVISION_CONFLICT");
    const invalid = await client.callTool({
      name: "create_creation",
      arguments: { ...args, ownerAccountId: "someone-else" },
    });
    expect(invalid.isError).toBe(true);
    const badArticle = await call(client, "create_creation", {
      content: {
        ...article,
        articleDocument: {
          type: "doc",
          content: [{ type: "script", text: "bad" }],
        },
      },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(badArticle.data.error.code).toBe("VALIDATION_ERROR");
    expect(
      (
        await call(client, "create_post", {
          content: { kind: "update", text: "Unapproved" },
          idempotencyKey: crypto.randomUUID(),
        })
      ).data.error.code,
    ).toBe("SCOPE_DENIED");
  });

  it("isolates simultaneous clients, including peer Agents owned by the same person", async () => {
    const f = fixture();
    const agents = [
      await activate(f),
      await activate(f),
      await activate(f, draftScopes, "bob"),
    ];
    const connected = await Promise.all(agents.map((a) => connect(f, a.token)));
    const saved = await Promise.all(
      connected.map((c, i) =>
        call(c, "create_creation", {
          content: { ...article, title: `Private ${i}` },
          idempotencyKey: "shared-test-key",
        }),
      ),
    );
    expect(new Set(saved.map((r) => r.data.workId)).size).toBe(3);
    for (let i = 0; i < connected.length; i++) {
      expect((await call(connected[i], "get_agent")).data.id).toBe(
        agents[i].id,
      );
      expect(
        (
          await call(connected[i], "get_creation", {
            id: saved[(i + 1) % 3].data.workId,
            draft: true,
          })
        ).data.error.code,
      ).toBe("NOT_FOUND");
      expect(
        (await call(connected[i], "list_my_creations")).data.items,
      ).toHaveLength(1);
    }
  });

  it("enforces pause, permission reduction, credential rotation and revocation after connection", async () => {
    const f = fixture();
    const agent = await activate(f, [...scopes]);
    const client = await connect(f, agent.token, true);
    const draft = await call(client, "create_creation", {
      content: article,
      idempotencyKey: crypto.randomUUID(),
    });
    const publish = {
      id: draft.data.workId,
      revisionId: draft.data.revisionId,
      idempotencyKey: crypto.randomUUID(),
    };
    expect((await call(client, "publish_creation", publish)).data.status).toBe(
      "published",
    );
    await control(f, agent.id, "pause");
    expect((await call(client, "get_agent")).data.status).toBe("paused");
    expect((await call(client, "list_tags")).data.error.code).toBe(
      "AGENT_PAUSED",
    );
    await control(f, agent.id, "resume");
    expect((await call(client, "list_tags")).data.tags).toHaveLength(6);
    expect(
      (
        await f.call(`/me/agents/${agent.id}`, {
          method: "PATCH",
          body: { scopes: draftScopes, confirmed: true },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(client, "publish_creation", publish)).data.error.code,
    ).toBe("SCOPE_DENIED");
    const rotated = await f.call(`/me/agents/${agent.id}/credentials/rotate`, {
      method: "POST",
      body: { confirmed: true },
    });
    expect(rotated.status).toBe(200);
    await expect(call(client, "get_agent")).rejects.toThrow();
    const next = await connect(f, rotated.data.credential.token);
    expect((await call(next, "get_agent")).data.id).toBe(agent.id);
    await control(f, agent.id, "revoke");
    await expect(call(next, "get_agent")).rejects.toThrow();
    await expect(connect(f, rotated.data.credential.token)).rejects.toThrow();
  });

  it("uses real community writes and image validation through the shared API", async () => {
    const f = fixture();
    expect(
      (
        await f.call("/me", {
          method: "PATCH",
          body: { name: "Alice", bio: "", avatarMediaId: null, join: true },
        })
      ).status,
    ).toBe(200);
    const agent = await activate(f, [...scopes]);
    const client = await connect(f, agent.token);
    const post = await call(client, "create_post", {
      content: { kind: "update", text: "Hello" },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(post.response.isError).not.toBe(true);
    expect(post.data.owner).not.toHaveProperty("ecosystems");
    for (const name of ["list_feed", "list_neighbors"]) {
      const page = await call(client, name);
      expect(page.data.items).toHaveLength(1);
      expect(JSON.stringify(page.data)).not.toContain('"ecosystems":');
    }
    const edited = await call(client, "edit_post", {
      id: post.data.id,
      revision: post.data.revision,
      content: { kind: "update", text: "Hello again" },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(edited.data.text).toBe("Hello again");
    expect(
      (await call(client, "get_post", { id: post.data.id })).data.text,
    ).toBe("Hello again");
    const reply = await call(client, "reply", {
      kind: "post",
      id: post.data.id,
      text: "A reply",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(reply.response.isError).not.toBe(true);
    expect(
      (await call(client, "list_comments", { kind: "post", id: post.data.id }))
        .data.items,
    ).toHaveLength(1);
    expect(
      (await call(client, "list_feed", { q: "HELLO again" })).data.items.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([post.data.id]);
    expect(
      (
        await call(client, "list_comments", {
          kind: "post",
          id: post.data.id,
          focus: reply.data.id,
        })
      ).data.items[0].id,
    ).toBe(reply.data.id);
    expect(
      (
        await call(client, "list_comments", {
          kind: "post",
          id: post.data.id,
          focus: "missing-comment",
        })
      ).data.httpStatus,
    ).toBe(404);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DQAAAEgQGADgLFJAAAAABJRU5ErkJggg==",
      "base64",
    );
    const upload = await call(client, "create_media_upload", {
      mimeType: "image/png",
      byteSize: png.length,
      purpose: "avatar",
    });
    expect(upload.response.isError).not.toBe(true);
    const uploaded = await f.app.request(
      "http://localhost" + upload.data.uploadUrl,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "X-Upload-Token": upload.data.uploadToken,
        },
        body: png,
      },
    );
    expect(uploaded.status).toBe(200);
    expect(
      (
        await call(client, "complete_media_upload", {
          id: upload.data.mediaId,
          idempotencyKey: crypto.randomUUID(),
        })
      ).response.isError,
    ).not.toBe(true);
    expect(
      (await call(client, "get_media", { id: upload.data.mediaId })).data
        .status,
    ).toBe("ready");
    expect(
      (await call(client, "get_media", { id: upload.data.mediaId })).data,
    ).toMatchObject({
      purpose: "avatar",
      width: 1,
      height: 1,
      mimeType: "image/webp",
    });
  });

  it("imports native host attachments without exposing upload credentials and replays by file ID", async () => {
    const f = fixture();
    const agent = await activate(f, [...scopes]);
    const client = await connect(f, agent.token);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DQAAAEgQGADgLFJAAAAABJRU5ErkJggg==",
      "base64",
    );
    const download = vi.fn(
      async () =>
        new Response(png, { headers: { "Content-Type": "image/png" } }),
    );
    vi.stubGlobal("fetch", download);
    const listed = await client.listTools();
    const tool = listed.tools.find((tool) => tool.name === "upload_image")!;
    expect(tool._meta?.["openai/fileParams"]).toEqual(["file"]);
    const schema = tool.inputSchema.properties!.file as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      "download_url",
      "file_id",
      "mime_type",
      "file_name",
    ]);
    expect(schema.required).toEqual(["download_url", "file_id"]);
    const args = {
      file: {
        file_id: "file-one",
        download_url:
          "https://files.oaiusercontent.com/attachment?temporary=one",
        mime_type: "image/png",
      },
      idempotencyKey: "native-image-one",
    };
    const imported = await call(client, "upload_image", args);
    expect(imported.data).toMatchObject({ httpStatus: 201, status: "ready" });
    expect(Object.keys(imported.data).sort()).toEqual([
      "httpStatus",
      "mediaId",
      "status",
    ]);
    expect(JSON.stringify(imported.response)).not.toMatch(
      /mcu_|uploadToken|temporary=one|download_url/,
    );
    expect(download).toHaveBeenCalledTimes(1);
    const request = download.mock.calls[0] as unknown as [URL, RequestInit];
    expect(request[1].headers).toBeUndefined();
    expect(request[1].redirect).toBe("manual");
    expect(f.store.objects.size).toBe(1);
    expect(
      (await call(client, "get_media", { id: imported.data.mediaId })).data,
    ).toMatchObject({ status: "ready", mimeType: "image/webp" });
    expect(
      (
        await call(client, "upload_image", {
          ...args,
          file: {
            ...args.file,
            download_url:
              "https://files.oaiusercontent.com/attachment?temporary=renewed",
          },
        })
      ).data,
    ).toEqual(imported.data);
    expect(download).toHaveBeenCalledTimes(1);
    expect(
      (
        await call(client, "upload_image", {
          ...args,
          file: { ...args.file, file_id: "file-other" },
        })
      ).data.httpStatus,
    ).toBe(409);
    expect(
      (
        await f.call("/media/imports", {
          method: "POST",
          token: agent.token,
          body: { file: args.file },
        })
      ).status,
    ).toBe(404);
    const bob = await activate(f, [...scopes], "bob");
    const bobClient = await connect(f, bob.token);
    expect(
      (await call(bobClient, "get_media", { id: imported.data.mediaId })).data
        .httpStatus,
    ).toBe(404);
  });

  it("bounds native file downloads and denies unsupported sources, redirects and content before storage", async () => {
    const f = fixture();
    const agent = await activate(f, [...scopes]);
    const client = await connect(f, agent.token);
    const download = vi.fn(async () => new Response("not an image"));
    vi.stubGlobal("fetch", download);
    let attempt = 0;
    const upload = (download_url: string) =>
      call(client, "upload_image", {
        file: { download_url, file_id: "file-test" },
        idempotencyKey: "native-negative-" + ++attempt,
      });
    for (const source of [
      "http://files.oaiusercontent.com/a",
      "https://127.0.0.1/a",
      "https://files.oaiusercontent.com.evil.example/a",
      "https://user:secret@files.oaiusercontent.com/a",
      "https://files.oaiusercontent.com:8443/a",
    ]) {
      expect((await upload(source)).data).toMatchObject({
        httpStatus: 400,
        error: { code: "INVALID_FILE_SOURCE" },
      });
    }
    expect(download).not.toHaveBeenCalled();
    download.mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/private" },
        }),
    );
    expect(
      (await upload("https://files.oaiusercontent.com/a")).data.error.code,
    ).toBe("INVALID_FILE_SOURCE");
    expect(download).toHaveBeenCalledTimes(1);
    download.mockImplementationOnce(
      async () =>
        new Response("large", { headers: { "Content-Length": "20971521" } }),
    );
    expect(
      (await upload("https://files.oaiusercontent.com/a")).data.httpStatus,
    ).toBe(413);
    expect(
      (await upload("https://files.oaiusercontent.com/a")).data.error.code,
    ).toBe("MEDIA_REJECTED");
    download.mockImplementationOnce(async () => {
      throw new Error("provider contains a private temporary URL");
    });
    const unavailable = await upload("https://files.oaiusercontent.com/a");
    expect(unavailable.data.error.code).toBe("FILE_UNAVAILABLE");
    expect(JSON.stringify(unavailable.response)).not.toContain(
      "provider contains",
    );
    expect(f.store.objects.size).toBe(0);
    await control(f, agent.id, "pause");
    const before = download.mock.calls.length;
    expect(
      (await upload("https://files.oaiusercontent.com/a")).data.httpStatus,
    ).toBe(403);
    expect(download.mock.calls.length).toBe(before);
  });

  it("rejects unsupported origins, hosts, credentials, oversized bodies and invalid protocol requests", async () => {
    const f = fixture();
    const agent = await activate(f);
    const headers = {
      Authorization: "Bearer " + agent.token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const request = (
      extra: Record<string, string> = {},
      url = "http://localhost/mcp",
      payload = body,
    ) =>
      f.app.request(url, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: payload,
      });
    expect((await request({ Origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await request({}, "http://evil.example/mcp")).status).toBe(403);
    expect(
      (await request({ Authorization: "Bearer fixture:alice" })).status,
    ).toBe(403);
    expect(
      (await request({ Authorization: "Bearer mcr_not-active" })).status,
    ).toBe(403);
    expect(
      (await request({ Authorization: "Bearer mca_invalid" })).status,
    ).toBe(401);
    const anonymous = await f.app.request("http://localhost/mcp", {
      method: "POST",
      headers: { Cookie: "privy-token=fixture:alice" },
      body,
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
    expect(
      (await request({}, undefined, "x".repeat(1024 * 1024 + 1))).status,
    ).toBe(413);
    expect((await request({}, undefined, "{")).status).toBe(400);
    expect(
      (await request({ "MCP-Protocol-Version": "not-supported" })).status,
    ).toBe(400);
    const get = await f.app.request("http://localhost/mcp", {
      headers: { Accept: "text/event-stream" },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const valid = await request();
    expect(valid.status).toBe(200);
    expect(valid.headers.has("mcp-session-id")).toBe(false);
    for (const response of [anonymous, get, valid]) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-request-id")).toMatch(/^req_/);
    }
  });
});
