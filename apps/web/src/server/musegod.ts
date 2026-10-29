import { z } from "zod";
import {
  museCount,
  placeIds,
  type MuseWorlds,
  type PlaceId,
} from "../shared/muses";
import { ApiError } from "./errors";

export type Fetched<T> = { value: T; asOf: string; stale: boolean };
export type ResponseCache = {
  match(r: Request): Promise<Response | undefined>;
  put(r: Request, res: Response): Promise<void>;
};
export type MuseRecord = {
  id: number;
  name: string;
  tier: string;
  patron: string;
  soul: { intro: string; tone: string[]; line: string } | null;
  kin: { id: number; name: string; tier: string }[];
  owner: string;
  agent: { agentId: number; wallet: string | null };
  worlds: MuseWorlds;
  images: { thumb: string; large: string };
};
export type CatalogEntry = {
  id: number;
  name: string;
  owner: string;
  thumb: string;
};
type Gallery = { living: number; muses: { id: number; linked: PlaceId[] }[] };
type PostResult = { status: number; code: string | null };
export type MusegodServices = {
  muse(id: number): Promise<Fetched<MuseRecord>>;
  catalog(): Promise<Fetched<CatalogEntry[]>>;
  gallery(): Promise<Fetched<Gallery>>;
  terrakinBadge(id: number): Promise<string | null>;
  pot(): Promise<{ muses: number[]; closes: number }>;
  founding(n: number): Promise<{ name: string } | null>;
  postWorlds(id: number, body: Record<string, unknown>): Promise<PostResult>;
  postMuseLink(body: Record<string, unknown>): Promise<PostResult>;
};

const minute = 60_000;
const museId = z.number().int().min(1).max(museCount);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .toLowerCase();
const url = z.url();
const world = z.object({
  linked: z.boolean().optional(),
  current: z.boolean().optional(),
  url: url.nullable().default(null),
  via: z.enum(["worn", "own"]).optional(),
});
const worlds = z
  .object({
    flock: world.optional(),
    musebook: world.optional(),
    terrakin: world.optional(),
    opensea: world.optional(),
    x: world.optional(),
    hiveverse: world.optional(),
    elsewhere: z.array(url).optional(),
  })
  .default({})
  .transform((value): MuseWorlds => {
    const result: MuseWorlds = {};
    for (const place of placeIds) {
      const entry = value[place];
      // Pool invitations, for example, do not carry confirmation or keeper
      // evidence. In particular, absence must not turn into current:false.
      if (!entry || entry.linked === undefined || entry.current === undefined)
        continue;
      result[place] = {
        linked: entry.linked,
        current: entry.current,
        url: entry.url,
        ...(entry.via ? { via: entry.via } : {}),
      };
    }
    if (value.elsewhere) result.elsewhere = value.elsewhere;
    return result;
  });
const muse = z
  .object({
    id: museId,
    name: z.string(),
    tier: z.string(),
    patron: z.string(),
    soul: z
      .object({
        intro: z.string(),
        tone: z.array(z.string()),
        line: z.string(),
      })
      .nullable(),
    kin: z.array(z.object({ id: museId, name: z.string(), tier: z.string() })),
    owner: z.object({ address }),
    agent: z.object({
      agentId: z.number().int().positive(),
      wallet: address.nullable(),
    }),
    worlds,
    links: z.object({ images: z.object({ "240": url, "1600": url }) }),
  })
  .transform(({ owner, links, ...value }): MuseRecord => ({
    ...value,
    owner: owner.address,
    images: { thumb: links.images["240"], large: links.images["1600"] },
  }));
const catalogPage = z.object({
  total: z.literal(museCount),
  muses: z.array(
    z
      .object({ id: museId, name: z.string(), owner: address, image: url })
      .transform(({ image, ...value }): CatalogEntry => ({
        ...value,
        thumb: image,
      })),
  ),
});
const gallery = z
  .object({
    living: z.number().int().nonnegative(),
    gallery: z.array(
      z.object({
        muse: museId,
        places: z.array(z.object({ id: z.string(), linked: z.boolean() })),
      }),
    ),
  })
  .transform((value): Gallery => ({
    living: value.living,
    muses: value.gallery.map((entry) => ({
      id: entry.muse,
      linked: placeIds.filter((place) =>
        entry.places.some((p) => p.id === place && p.linked),
      ),
    })),
  }));
const registration = z.object({
  services: z.array(z.object({ name: z.string(), endpoint: url })),
});
const pot = z
  .object({
    week: z.object({
      muses: z.array(museId),
      closes: z.number().int().nonnegative(),
    }),
  })
  .transform((value) => value.week);
const founding = z
  .object({ agent: z.object({ name: z.string() }) })
  .transform((value) => value.agent);
const postError = z.object({ error: z.object({ code: z.string() }) });

function unavailable() {
  return new ApiError(
    503,
    "MUSEGOD_UNAVAILABLE",
    "Muse data is unavailable right now.",
  );
}

function allowedUrl(value: string) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !["musegod.org", "flock.musegod.org"].includes(parsed.hostname)
  )
    throw unavailable();
  return parsed;
}

function checkedId(value: number, schema = museId) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

export function musegodOrg(opts: {
  fetch?: typeof fetch;
  cache?: ResponseCache;
  now?: () => number;
}): MusegodServices {
  const fetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;

  async function request<T>(
    value: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    // Validate every actual request, including POSTs. Remote image and evidence
    // URLs are data only and are never fetched by this client.
    const target = allowedUrl(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(target.href, {
        ...init,
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      });
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel();
        throw unavailable();
      }
      return await consume(response);
    } finally {
      clearTimeout(timer);
    }
  }

  async function read<T>(
    target: string,
    schema: z.ZodType<T>,
    ttl: number,
  ): Promise<Fetched<T>> {
    const key = new Request(allowedUrl(target));
    let snapshot: Fetched<T> | undefined;
    try {
      const cached = await opts.cache?.match(key);
      const asOf = cached?.headers.get("x-fetched-at");
      if (cached?.ok && asOf) {
        const timestamp = Date.parse(asOf);
        const parsed = schema.safeParse(await cached.json());
        if (
          parsed.success &&
          Number.isFinite(timestamp) &&
          timestamp <= now()
        ) {
          snapshot = {
            value: parsed.data,
            asOf,
            stale: now() - timestamp >= ttl,
          };
          if (!snapshot.stale) return snapshot;
        }
      }
    } catch {
      // A missing, evicted or unusable cache entry is not remote evidence.
    }

    let retryable = false;
    try {
      return await request(target, {}, async (response) => {
        if (!response.ok) {
          retryable = response.status >= 500;
          await response.body?.cancel();
          throw unavailable();
        }
        let wire: unknown;
        try {
          wire = await response.json();
        } catch (error) {
          if (error instanceof SyntaxError) throw unavailable();
          throw error;
        }
        const parsed = schema.safeParse(wire);
        if (!parsed.success) throw unavailable();
        const asOf = new Date(now()).toISOString();
        try {
          await opts.cache?.put(
            key,
            Response.json(wire, {
              headers: {
                "x-fetched-at": asOf,
                // Freshness is enforced above. Retain snapshots beyond every
                // logical TTL so Cache API expiry does not defeat stale fallback.
                "cache-control": "public, max-age=604800",
              },
            }),
          );
        } catch {
          // Cache availability must not discard a validated public response.
        }
        return { value: parsed.data, asOf, stale: false };
      });
    } catch (error) {
      if (snapshot && (retryable || !(error instanceof ApiError)))
        return { ...snapshot, stale: true };
      throw unavailable();
    }
  }

  async function post(
    target: string,
    body: Record<string, unknown>,
  ): Promise<PostResult> {
    try {
      return await request(
        target,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        async (response) => {
          let code: string | null = null;
          try {
            const parsed = postError.safeParse(await response.json());
            if (parsed.success) code = parsed.data.error.code;
          } catch {
            // Never expose a remote message, HTML error page or transport detail.
          }
          return { status: response.status, code };
        },
      );
    } catch {
      // The relay can retry an uncertain network result within the signature's
      // validity window using the same body, just as it retries a remote 503.
      return { status: 503, code: null };
    }
  }

  return {
    async muse(id) {
      id = checkedId(id);
      return read(
        `https://musegod.org/api/v1/muses/${id}`,
        muse.refine((value) => value.id === id),
        5 * minute,
      );
    },
    async catalog() {
      const pages: Fetched<z.infer<typeof catalogPage>>[] = [];
      for (let offset = 0; offset < museCount; offset += 100) {
        pages.push(
          await read(
            `https://musegod.org/api/v1/muses?limit=100&offset=${offset}`,
            catalogPage.refine(
              (page) => page.muses.length === Math.min(100, museCount - offset),
            ),
            360 * minute,
          ),
        );
      }
      const value = pages.flatMap((page) => page.value.muses);
      if (new Set(value.map((entry) => entry.id)).size !== museCount)
        throw unavailable();
      return {
        value,
        asOf: pages.map((page) => page.asOf).sort()[0],
        stale: pages.some((page) => page.stale),
      };
    },
    gallery: () =>
      read("https://musegod.org/api/v1/worlds", gallery, 15 * minute),
    async terrakinBadge(id) {
      const result = await read(
        `https://musegod.org/muse/${checkedId(id)}.json`,
        registration,
        15 * minute,
      );
      return (
        result.value.services.find((service) => service.name === "terrakin")
          ?.endpoint ?? null
      );
    },
    async pot() {
      return (await read("https://musegod.org/api/v1/pot", pot, 5 * minute))
        .value;
    },
    async founding(n) {
      n = checkedId(
        n,
        z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      );
      try {
        // No founding TTL is specified: validate the current public name when
        // an Agent reports its number rather than retaining a stale identity.
        return await request(
          `https://flock.musegod.org/api/v1/founding/${n}`,
          {},
          async (response) => {
            if (response.status === 404) {
              await response.body?.cancel();
              return null;
            }
            if (!response.ok) {
              await response.body?.cancel();
              throw unavailable();
            }
            const parsed = founding.safeParse(await response.json());
            if (!parsed.success) throw unavailable();
            return parsed.data;
          },
        );
      } catch {
        throw unavailable();
      }
    },
    postWorlds: async (id, body) =>
      post(`https://musegod.org/api/v1/muses/${checkedId(id)}/worlds`, body),
    postMuseLink: (body) => post("https://musegod.org/api/v1/muse-link", body),
  };
}
