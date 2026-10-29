import { isAddress } from "viem";
import { ApiError } from "./errors";
import type { ResponseCache } from "./musegod";
import { museContract, museCount } from "../shared/muses";
export type OwnershipServices = { ownerOf(tokenId: number): Promise<string> };
import { ownershipUnavailableMessage } from "../shared/muses";
export { ownershipUnavailableMessage } from "../shared/muses";
function unavailable() {
  return new ApiError(
    503,
    "OWNERSHIP_UNAVAILABLE",
    ownershipUnavailableMessage,
  );
}
function ownerOf(value: unknown): string {
  const owners = (
    value as {
      nft?: { owners?: { address?: unknown; quantity?: unknown }[] };
    } | null
  )?.nft?.owners;
  const owner = Array.isArray(owners) && owners.length === 1 ? owners[0] : null;
  if (
    !owner ||
    typeof owner.address !== "string" ||
    !isAddress(owner.address, { strict: false }) ||
    ![1, "1"].includes(owner.quantity as string | number)
  )
    throw unavailable();
  return owner.address.toLowerCase();
}
export function openseaOwnership(opts: {
  apiKey?: string;
  fetch?: typeof fetch;
  cache?: ResponseCache;
  now?: () => number;
}): OwnershipServices {
  const fetcher = opts.fetch ?? fetch,
    now = opts.now ?? Date.now;
  return {
    async ownerOf(tokenId) {
      if (
        !opts.apiKey ||
        !Number.isInteger(tokenId) ||
        tokenId < 1 ||
        tokenId > museCount
      )
        throw unavailable();
      const url = new URL(
        "https://api.opensea.io/api/v2/chain/robinhood/contract/" +
          museContract +
          "/nfts/" +
          tokenId,
      );
      if (url.protocol !== "https:" || url.hostname !== "api.opensea.io")
        throw unavailable();
      const cacheKey = new Request(url);
      try {
        const cached = await opts.cache?.match(cacheKey);
        const timestamp = Number(cached?.headers.get("x-owned-at") ?? NaN);
        if (
          cached?.ok &&
          Number.isFinite(timestamp) &&
          timestamp <= now() &&
          now() - timestamp < 60_000
        )
          return ownerOf(await cached.json());
      } catch {
        /* An unusable cache entry requires a fresh lookup, never stale ownership. */
      }
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetcher(url.href, {
          method: "GET",
          headers: { "x-api-key": opts.apiKey },
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
        });
        if (!response.ok || response.redirected) {
          await response.body?.cancel();
          throw unavailable();
        }
        const wire: unknown = await response.json();
        const owner = ownerOf(wire);
        try {
          await opts.cache?.put(
            cacheKey,
            Response.json(
              { nft: { owners: [{ address: owner, quantity: 1 }] } },
              {
                headers: {
                  "Cache-Control": "public, max-age=60",
                  "x-owned-at": String(now()),
                },
              },
            ),
          );
        } catch {
          /* Cache storage does not change a verified response. */
        }
        return owner;
      } catch {
        throw unavailable();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
