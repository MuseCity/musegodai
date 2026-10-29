import { afterEach, expect, it, vi } from "vitest";
import { openseaOwnership } from "../src/server/opensea";
import type { ResponseCache } from "../src/server/musegod";
const owner = "0xaabbccddeeff00112233445566778899aabbccdd";
const key = crypto.randomUUID();
const wire = {
  nft: {
    owners: [{ address: owner.toUpperCase().replace("0X", "0x"), quantity: 1 }],
  },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("reads only the fixed OpenSea NFT endpoint, authenticates in a header, and caches valid ownership for exactly 60 seconds", async () => {
  let now = 1_000_000;
  const entries = new Map<string, Response>();
  const cache: ResponseCache = {
    match: async (r) => entries.get(r.url)?.clone(),
    put: async (r, response) => {
      expect([...r.headers]).toEqual([]);
      entries.set(r.url, response.clone());
    },
  };
  const fetcher = vi.fn(async (input, init) => {
    expect(String(input)).toBe(
      "https://api.opensea.io/api/v2/chain/robinhood/contract/0x13ea3072b7215d4c9c2ec4f498a08c5825129836/nfts/259",
    );
    expect(new Headers(init?.headers).get("x-api-key") === key).toBe(true);
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(wire);
  }) as typeof fetch & ReturnType<typeof vi.fn>;
  const service = () =>
    openseaOwnership({ apiKey: key, fetch: fetcher, cache, now: () => now });
  expect(await service().ownerOf(259)).toBe(owner);
  now += 59_999;
  expect(await service().ownerOf(259)).toBe(owner);
  expect(fetcher).toHaveBeenCalledTimes(1);
  now++;
  expect(await service().ownerOf(259)).toBe(owner);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify([...entries.keys()]).includes(key)).toBe(false);
});
it.each([
  undefined,
  {},
  { nft: { owners: [] } },
  {
    nft: {
      owners: [
        { address: owner, quantity: 1 },
        { address: owner, quantity: 1 },
      ],
    },
  },
  { nft: { owners: [{ address: "invalid", quantity: 1 }] } },
  { nft: { owners: [{ address: owner, quantity: 0 }] } },
])("rejects ambiguous or malformed ownership %j", async (body) => {
  const fetcher = vi.fn(async () => Response.json(body ?? null));
  await expect(
    openseaOwnership({ apiKey: key, fetch: fetcher }).ownerOf(259),
  ).rejects.toMatchObject({ status: 503, code: "OWNERSHIP_UNAVAILABLE" });
});
it.each([301, 302, 307, 401, 403, 404, 429, 500, 503])(
  "refuses HTTP %s without following redirects or leaking credentials",
  async (status) => {
    const fetcher = vi.fn(
      async () =>
        new Response(key, {
          status,
          headers: { location: "https://untrusted.example.test" },
        }),
    );
    const error = await openseaOwnership({ apiKey: key, fetch: fetcher })
      .ownerOf(259)
      .catch((e) => e);
    expect(error).toMatchObject({
      status: 503,
      code: "OWNERSHIP_UNAVAILABLE",
      message:
        "We can't check who holds this muse right now. This isn't a problem with your wallet. Please try again in a minute.",
    });
    expect((String(error) + JSON.stringify(error)).includes(key)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("fails closed without a key, on bad token references, network/JSON errors, and stale ownership", async () => {
  const fetcher = vi.fn(async () => {
    throw new Error(key);
  });
  await expect(
    openseaOwnership({ fetch: fetcher }).ownerOf(259),
  ).rejects.toMatchObject({ code: "OWNERSHIP_UNAVAILABLE" });
  expect(fetcher).not.toHaveBeenCalled();
  for (const id of [0, 1000, 1.5, NaN])
    await expect(
      openseaOwnership({ apiKey: key, fetch: fetcher }).ownerOf(id),
    ).rejects.toMatchObject({ code: "OWNERSHIP_UNAVAILABLE" });
  expect(fetcher).not.toHaveBeenCalled();
  const error = await openseaOwnership({ apiKey: key, fetch: fetcher })
    .ownerOf(259)
    .catch((e) => e);
  expect(JSON.stringify(error).includes(key)).toBe(false);
  await expect(
    openseaOwnership({
      apiKey: key,
      fetch: vi.fn(async () => new Response("not JSON")),
    }).ownerOf(259),
  ).rejects.toMatchObject({ code: "OWNERSHIP_UNAVAILABLE" });
});
it("aborts a stalled request after five seconds", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
  );
  const pending = expect(
    openseaOwnership({ apiKey: key, fetch: fetcher }).ownerOf(259),
  ).rejects.toMatchObject({ code: "OWNERSHIP_UNAVAILABLE" });
  await vi.advanceTimersByTimeAsync(5000);
  await pending;
});

it("never serves stale ownership or uses a cached owner when the API key is missing", async () => {
  const cached = Response.json(
    { nft: { owners: [{ address: owner, quantity: 1 }] } },
    { headers: { "x-owned-at": "1000000" } },
  );
  const cache: ResponseCache = {
    match: async () => cached.clone(),
    put: async () => {},
  };
  const fetcher = vi.fn(async () => {
    throw new Error("Local upstream unavailable");
  });
  await expect(
    openseaOwnership({
      apiKey: key,
      fetch: fetcher,
      cache,
      now: () => 1060000,
    }).ownerOf(259),
  ).rejects.toMatchObject({ code: "OWNERSHIP_UNAVAILABLE" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(
    openseaOwnership({ fetch: fetcher, cache, now: () => 1000001 }).ownerOf(
      259,
    ),
  ).rejects.toMatchObject({ code: "OWNERSHIP_UNAVAILABLE" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
