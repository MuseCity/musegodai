import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/server/errors";
import { musegodOrg, type ResponseCache } from "../src/server/musegod";
import { deriveSteps } from "../src/shared/muse-steps";

const start = Date.parse("2026-10-29T08:00:00.000Z");
const owner = "0x00A839de7922491683F547a67795204763ff8237";
const wallet = "0xABa839de7922491683F547a67795204763ff8237";
const unavailable = {
  status: 503,
  code: "MUSEGOD_UNAVAILABLE",
  message: "Muse data is unavailable right now.",
};

function museWire() {
  return {
    id: 1,
    name: "Bard",
    tier: "Common",
    patron: "Calliope",
    soul: null,
    kin: [{ id: 131, name: "Clapper", tier: "Rare", secret: "ignored" }],
    owner: { address: owner, name: "public name" },
    agent: { agentId: 6592, wallet, adapter: "ignored" },
    links: {
      images: {
        "240": "https://images.example/bard-small.jpg",
        "1600": "https://images.example/bard-large.jpg",
      },
    },
    ignored: "not part of the client contract",
  };
}

function catalogWire(offset: number) {
  return {
    total: 999,
    offset,
    limit: 100,
    muses: Array.from({ length: Math.min(100, 999 - offset) }, (_, i) => ({
      id: offset + i + 1,
      name: `Muse ${offset + i + 1}`,
      owner,
      image: `https://musegod.org/muse/art/${offset + i + 1}.jpg`,
      tier: "Common",
    })),
  };
}

function requestUrl(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : String(input));
}

function fakeFetch(
  answer: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    expect(["musegod.org", "flock.musegod.org"]).toContain(url.hostname);
    expect(url.protocol).toBe("https:");
    expect(url.port).toBe("");
    expect(url.username).toBe("");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    return answer(url, init);
  });
}

// Model Cache API expiry as well as cloning, so logical freshness cannot
// accidentally become the cache's eviction time and erase stale snapshots.
class MemoryCache implements ResponseCache {
  entries = new Map<string, { response: Response; expires: number }>();
  constructor(private now: () => number) {}
  async match(request: Request) {
    const entry = this.entries.get(request.url);
    if (!entry || entry.expires <= this.now()) return undefined;
    return entry.response.clone();
  }
  async put(request: Request, response: Response) {
    const maxAge = response.headers
      .get("cache-control")
      ?.match(/(?:^|,)\s*max-age=(\d+)/)?.[1];
    this.entries.set(request.url, {
      response: response.clone(),
      expires: maxAge ? this.now() + Number(maxAge) * 1000 : Infinity,
    });
  }
}

function harness(answer = () => Response.json(museWire())) {
  let time = start;
  const now = () => time;
  const cache = new MemoryCache(now);
  const fetch = fakeFetch(answer);
  const client = musegodOrg({ fetch, cache, now });
  return { client, fetch, cache, now, advance: (ms: number) => (time += ms) };
}

afterEach(() => vi.useRealTimers());

describe("Musegod public client", () => {
  it("parses partial records without worlds and with a null soul", async () => {
    const { client } = harness();
    expect(await client.muse(1)).toEqual({
      value: {
        id: 1,
        name: "Bard",
        tier: "Common",
        patron: "Calliope",
        soul: null,
        kin: [{ id: 131, name: "Clapper", tier: "Rare" }],
        owner: owner.toLowerCase(),
        agent: { agentId: 6592, wallet: wallet.toLowerCase() },
        worlds: {},
        images: {
          thumb: "https://images.example/bard-small.jpg",
          large: "https://images.example/bard-large.jpg",
        },
      },
      asOf: new Date(start).toISOString(),
      stale: false,
    });
  });

  it("normalizes soul and worlds without inventing incomplete place evidence", async () => {
    const wire = {
      ...museWire(),
      soul: {
        intro: "I am Bard.",
        tone: ["friendly"],
        line: "A saga.",
        who: "extra",
      },
      agent: { agentId: 6592, wallet: null },
      worlds: {
        flock: {
          linked: true,
          current: true,
          url: "https://musegod.org/flock/1",
          week: 7,
        },
        opensea: {
          linked: true,
          current: false,
          url: "https://opensea.io/bard",
          via: "worn",
        },
        hiveverse: {
          url: "https://hivemindos.app/hiveverse/?muse=1",
          pool: true,
        },
        elsewhere: ["https://musegod.ai/muses/1"],
        future: { linked: true, current: true, url: "https://example.com" },
      },
    };
    const { client } = harness(() => Response.json(wire));
    const { value } = await client.muse(1);
    expect(value.soul).toEqual({
      intro: "I am Bard.",
      tone: ["friendly"],
      line: "A saga.",
    });
    expect(value.worlds).toEqual({
      flock: {
        linked: true,
        current: true,
        url: "https://musegod.org/flock/1",
      },
      opensea: {
        linked: true,
        current: false,
        url: "https://opensea.io/bard",
        via: "worn",
      },
      elsewhere: ["https://musegod.ai/muses/1"],
    });
    const steps = deriveSteps({
      reports: {},
      connected: false,
      helloPostId: null,
      worlds: value.worlds,
    });
    expect(steps.find((s) => s.id === "hiveverse")).toMatchObject({
      status: "pending",
      lastKeeper: false,
    });
    expect(steps.find((s) => s.id === "opensea")).toMatchObject({
      status: "pending",
      lastKeeper: true,
    });
  });

  it("shares fresh snapshots between clients and records the fetch time", async () => {
    const h = harness();
    const first = await h.client.muse(1);
    h.advance(299_999);
    expect(
      await musegodOrg({ fetch: h.fetch, cache: h.cache, now: h.now }).muse(1),
    ).toEqual(first);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const stored = await h.cache.match(
      new Request("https://musegod.org/api/v1/muses/1"),
    );
    expect(stored?.headers.get("x-fetched-at")).toBe(first.asOf);
  });

  it("refetches at the five-minute freshness boundary", async () => {
    const h = harness();
    await h.client.muse(1);
    h.advance(300_000);
    const next = await h.client.muse(1);
    expect(next).toMatchObject({
      stale: false,
      asOf: new Date(start + 300_000).toISOString(),
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("serves a retained stale snapshot after five minutes and a 503", async () => {
    const h = harness();
    const first = await h.client.muse(1);
    h.advance(300_001);
    h.fetch.mockResolvedValueOnce(
      new Response("private upstream failure", { status: 503 }),
    );
    expect(await h.client.muse(1)).toEqual({ ...first, stale: true });
    h.advance(86_400_000);
    h.fetch.mockRejectedValueOnce(new Error("network details"));
    expect(await h.client.muse(1)).toEqual({ ...first, stale: true });
  });

  it("aborts a stalled read after five seconds and serves stale", async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = await h.client.muse(1);
    h.advance(300_001);
    h.fetch.mockImplementationOnce(
      async (_input, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("timeout details")),
            { once: true },
          );
        }),
    );
    const pending = h.client.muse(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.fetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ...first, stale: true });
    expect(h.fetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  });

  it.each(["network", "503"])(
    "fails cleanly with no copy on %s failure",
    async (failure) => {
      const h = harness();
      if (failure === "network")
        h.fetch.mockRejectedValueOnce(new Error("secret upstream detail"));
      else
        h.fetch.mockResolvedValueOnce(
          new Response("secret upstream detail", { status: 503 }),
        );
      await expect(h.client.muse(1)).rejects.toBeInstanceOf(ApiError);
      await expect(h.client.muse(1)).resolves.toHaveProperty("value.id", 1);
      if (failure === "network")
        h.fetch.mockRejectedValueOnce(new Error("secret upstream detail"));
      else
        h.fetch.mockResolvedValueOnce(
          new Response("secret upstream detail", { status: 503 }),
        );
      await expect(h.client.muse(2)).rejects.toMatchObject(unavailable);
    },
  );

  it.each([
    { ...museWire(), owner: { address: "not an address" } },
    { ...museWire(), id: 2 },
    { ...museWire(), soul: { intro: 3 } },
  ])(
    "rejects malformed or mismatched muse records without caching them",
    async (wire) => {
      const h = harness(() => Response.json(wire));
      await expect(h.client.muse(1)).rejects.toMatchObject(unavailable);
      expect(h.cache.entries.size).toBe(0);
    },
  );

  it("rejects invalid JSON without exposing remote text", async () => {
    const h = harness(() => new Response("remote private message"));
    await expect(h.client.muse(1)).rejects.toMatchObject(unavailable);
  });

  it("refreshes malformed cached data instead of trusting its timestamp", async () => {
    const h = harness();
    await h.cache.put(
      new Request("https://musegod.org/api/v1/muses/1"),
      Response.json(
        { private: "bad" },
        {
          headers: {
            "x-fetched-at": new Date(start).toISOString(),
            "cache-control": "public, max-age=604800",
          },
        },
      ),
    );
    expect(await h.client.muse(1)).toHaveProperty("value.name", "Bard");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns validated reads when cache access fails", async () => {
    const cache: ResponseCache = {
      async match() {
        throw new Error("cache unavailable");
      },
      async put() {
        throw new Error("cache full");
      },
    };
    const fetch = fakeFetch(() => Response.json(museWire()));
    expect(await musegodOrg({ fetch, cache }).muse(1)).toHaveProperty(
      "value.name",
      "Bard",
    );
  });

  it("does not hide a 404 behind a stale snapshot", async () => {
    const h = harness();
    await h.client.muse(1);
    h.advance(300_001);
    h.fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "not public" } }, { status: 404 }),
    );
    await expect(h.client.muse(1)).rejects.toMatchObject(unavailable);
  });

  it("catalog pages to 999 with limit 100 and caches each page for six hours", async () => {
    let time = start;
    const now = () => time;
    const fetch = fakeFetch((url) => {
      expect(url.pathname).toBe("/api/v1/muses");
      expect(url.searchParams.get("limit")).toBe("100");
      return Response.json(catalogWire(Number(url.searchParams.get("offset"))));
    });
    const client = musegodOrg({ fetch, cache: new MemoryCache(now), now });
    const first = await client.catalog();
    expect(first.value).toHaveLength(999);
    expect(first.value[0]).toEqual({
      id: 1,
      name: "Muse 1",
      owner: owner.toLowerCase(),
      thumb: "https://musegod.org/muse/art/1.jpg",
    });
    expect(first.value.at(-1)?.id).toBe(999);
    expect(fetch).toHaveBeenCalledTimes(10);
    time += 21_599_999;
    expect(await client.catalog()).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(10);
    time += 1;
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const mixed = await client.catalog();
    expect(mixed).toMatchObject({ stale: true, asOf: first.asOf });
    expect(mixed.value).toHaveLength(999);
    expect(fetch).toHaveBeenCalledTimes(20);
  });

  it.each(["short", "duplicate"])(
    "rejects a %s catalog instead of returning incomplete directory data",
    async (kind) => {
      const fetch = fakeFetch((url) => {
        const page = catalogWire(Number(url.searchParams.get("offset")));
        if (kind === "short") page.muses = page.muses.slice(0, 1);
        else page.muses[1] = page.muses[0];
        return Response.json(page);
      });
      await expect(musegodOrg({ fetch }).catalog()).rejects.toMatchObject(
        unavailable,
      );
    },
  );

  it("refuses other hosts even through runtime arguments and never fetches external images", async () => {
    const fetch = fakeFetch((url) =>
      url.hostname === "flock.musegod.org"
        ? Response.json({ agent: { name: "Bard" } })
        : Response.json(museWire()),
    );
    const client = musegodOrg({ fetch });
    expect(await client.muse(1)).toHaveProperty(
      "value.images.thumb",
      "https://images.example/bard-small.jpg",
    );
    expect(await client.founding(12)).toEqual({ name: "Bard" });
    await expect(
      client.founding("https://evil.example" as unknown as number),
    ).rejects.toMatchObject(unavailable);
    await expect(
      client.muse("//evil.example" as unknown as number),
    ).rejects.toMatchObject(unavailable);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map(([input]) => requestUrl(input).hostname),
    ).toEqual(["musegod.org", "flock.musegod.org"]);
  });

  it.each([
    "https://evil.example/secret",
    "https://musegod.org/api/v1/muses/2",
  ])("refuses manual redirects to %s", async (location) => {
    const h = harness(
      () => new Response(null, { status: 302, headers: { location } }),
    );
    await expect(h.client.muse(1)).rejects.toMatchObject(unavailable);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes linked gallery places and refreshes after fifteen minutes", async () => {
    const wire = {
      living: 125,
      gallery: [
        {
          muse: 323,
          places: [
            { id: "flock", linked: true, active: false },
            { id: "musebook", linked: false, active: true },
            { id: "x", linked: true },
            { id: "future", linked: true },
          ],
        },
      ],
    };
    const h = harness(() => Response.json(wire));
    const first = await h.client.gallery();
    expect(first.value).toEqual({
      living: 125,
      muses: [{ id: 323, linked: ["flock", "x"] }],
    });
    h.advance(899_999);
    expect(await h.client.gallery()).toEqual(first);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.client.gallery();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("reads Terrakin services and refreshes registration data after fifteen minutes", async () => {
    const h = harness(() =>
      Response.json({
        services: [
          { name: "web", endpoint: "https://musegod.org/muse/1" },
          {
            name: "terrakin",
            endpoint: "https://terrakin.org/r/r_0123456789abcdef",
            extra: "ignored",
          },
        ],
      }),
    );
    expect(await h.client.terrakinBadge(1)).toBe(
      "https://terrakin.org/r/r_0123456789abcdef",
    );
    h.advance(899_999);
    await h.client.terrakinBadge(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.fetch.mockResolvedValueOnce(
      Response.json({
        services: [{ name: "web", endpoint: "https://musegod.org/muse/1" }],
      }),
    );
    expect(await h.client.terrakinBadge(1)).toBeNull();
    expect(requestUrl(h.fetch.mock.calls[0][0]).pathname).toBe("/muse/1.json");
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("reads the weekly pot and refreshes after five minutes", async () => {
    const h = harness(() =>
      Response.json({
        week: { muses: [1, 323], closes: 1793547000, id: 7 },
        pot: "ignored",
      }),
    );
    expect(await h.client.pot()).toEqual({
      muses: [1, 323],
      closes: 1793547000,
    });
    h.advance(299_999);
    await h.client.pot();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.client.pot();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(requestUrl(h.fetch.mock.calls[0][0]).pathname).toBe("/api/v1/pot");
  });

  it("reads founding names from the agent wrapper and returns null only when missing", async () => {
    const fetch = fakeFetch(() =>
      Response.json({ agent: { name: "Bard", number: 12 }, answers: [] }),
    );
    const client = musegodOrg({ fetch });
    expect(await client.founding(12)).toEqual({ name: "Bard" });
    fetch.mockResolvedValueOnce(
      Response.json({ error: { code: "not_found" } }, { status: 404 }),
    );
    expect(await client.founding(999999)).toBeNull();
    fetch.mockResolvedValueOnce(Response.json({ agent: { name: 12 } }));
    await expect(client.founding(12)).rejects.toMatchObject(unavailable);
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(client.founding(12)).rejects.toMatchObject(unavailable);
    expect(requestUrl(fetch.mock.calls[0][0]).href).toBe(
      "https://flock.musegod.org/api/v1/founding/12",
    );
  });

  it("relays POST results with only status and nested error code", async () => {
    const fetch = fakeFetch(() =>
      Response.json(
        {
          error: { code: "rate_limited", message: "private upstream message" },
          other: "ignored",
        },
        { status: 429 },
      ),
    );
    const client = musegodOrg({ fetch });
    const body = {
      place: "terrakin",
      url: "https://terrakin.org/r/r_0123456789abcdef",
      signer: owner,
      signature: "0x1234",
    };
    expect(await client.postWorlds(1, body)).toEqual({
      status: 429,
      code: "rate_limited",
    });
    expect(requestUrl(fetch.mock.calls[0][0]).pathname).toBe(
      "/api/v1/muses/1/worlds",
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(
      new Headers(fetch.mock.calls[0][1]?.headers).get("content-type"),
    ).toBe("application/json");
    fetch.mockResolvedValueOnce(
      Response.json({ stored: true, message: "not returned" }),
    );
    expect(await client.postMuseLink({ id: 1, endpoint: body.url })).toEqual({
      status: 200,
      code: null,
    });
    expect(requestUrl(fetch.mock.calls[1][0]).pathname).toBe(
      "/api/v1/muse-link",
    );
  });

  it("keeps POST failures bounded and never exposes malformed error bodies", async () => {
    const fetch = fakeFetch(
      () => new Response("private remote text", { status: 422 }),
    );
    const client = musegodOrg({ fetch });
    expect(await client.postMuseLink({})).toEqual({ status: 422, code: null });
    fetch.mockRejectedValueOnce(new Error("private network details"));
    expect(await client.postMuseLink({})).toEqual({ status: 503, code: null });
    fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { location: "https://evil.example" },
      }),
    );
    expect(await client.postMuseLink({})).toEqual({ status: 503, code: null });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("returns a retryable 503 when POST transport times out after five seconds", async () => {
    vi.useFakeTimers();
    const fetch = fakeFetch(
      async (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private timeout details")),
            { once: true },
          );
        }),
    );
    const pending = musegodOrg({ fetch }).postWorlds(1, { place: "elsewhere" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ status: 503, code: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
