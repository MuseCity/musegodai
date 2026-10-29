import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { verifyMessage, type Address } from "viem";
import { ApiError } from "../src/server/errors";
import type { MuseChain } from "../src/server/muse-chain";
import type { MusegodServices, MuseRecord } from "../src/server/musegod";
import type { WalletServices } from "../src/server/wallets";
import { type PlaceId } from "../src/shared/muses";
import type { fixture } from "./helpers";

export const addresses = {
  alice: "0x1111111111111111111111111111111111111111",
  external: "0x2222222222222222222222222222222222222222",
  bob: "0x3333333333333333333333333333333333333333",
  agent: "0x4444444444444444444444444444444444444444",
  stranger: "0x5555555555555555555555555555555555555555",
  delegate: "0x6666666666666666666666666666666666666666",
};

export function withMuses(f: ReturnType<typeof fixture>) {
  const names = JSON.parse(
    readFileSync("tests/fixtures/muse-names.json", "utf8"),
  ) as { id: number; name: string }[];
  const records = new Map<number, MuseRecord>(
    names.map(({ id, name }) => [
      id,
      {
        id,
        name,
        tier: "Common",
        patron: "Calliope",
        soul: { intro: `I am ${name}.`, tone: ["friendly"], line: "A saga." },
        kin: [],
        owner: id === 1 ? addresses.alice : addresses.stranger,
        agent: { agentId: 6591 + id, wallet: addresses.agent },
        worlds: {},
        images: {
          thumb: `https://musegod.org/muse/art/240/${id}.jpg`,
          large: `https://musegod.org/muse/art/1600/${id}.jpg`,
        },
      },
    ]),
  );
  const owners = new Map([...records].map(([id, m]) => [id, m.owner]));
  const linked = new Map<string, string[]>([
    ["did:privy:alice", [addresses.alice, addresses.external]],
    ["did:privy:bob", [addresses.bob]],
  ]);
  const fetched = <T>(value: T) => ({
    value: structuredClone(value),
    asOf: "2026-10-29T00:00:00.000Z",
    stale: false,
  });
  const gallery = {
    living: 125,
    muses: [] as { id: number; linked: PlaceId[] }[],
  };
  const week = {
    muses: [] as number[],
    closes: Math.floor(Date.now() / 1000) + 86400,
  };
  const foundings = new Map<number, { name: string }>([[12, { name: "Bard" }]]);
  const musegod = {
    muse: vi.fn(async (id: number) => {
      const record = records.get(id);
      if (!record)
        throw new ApiError(503, "MUSEGOD_UNAVAILABLE", "Unavailable.");
      return fetched(record);
    }),
    catalog: vi.fn(async () =>
      fetched(
        [...records.values()].map((m) => ({
          id: m.id,
          name: m.name,
          owner: m.owner,
          thumb: m.images.thumb,
        })),
      ),
    ),
    gallery: vi.fn(async () => fetched(gallery)),
    terrakinBadge: vi.fn(async (_id: number): Promise<string | null> => null),
    pot: vi.fn(async () => structuredClone(week)),
    founding: vi.fn(async (n: number) => foundings.get(n) ?? null),
    postWorlds: vi.fn(async (_id: number, _body: Record<string, unknown>) => ({
      status: 200,
      code: null,
    })),
    postMuseLink: vi.fn(async (_body: Record<string, unknown>) => ({
      status: 200,
      code: null,
    })),
  } satisfies MusegodServices;
  const ownership = { ownerOf: vi.fn(async (id: number) => owners.get(id)!) };
  const chain = {
    verifyMessage: vi.fn(
      async (address: string, message: string, signature: `0x${string}`) => {
        try {
          return await verifyMessage({
            address: address as Address,
            message,
            signature,
          });
        } catch {
          return false;
        }
      },
    ),
  } satisfies MuseChain;
  const wallets = {
    findWallet: vi.fn(async () => null),
    linkedAddresses: vi.fn(async (userId: string) => linked.get(userId) ?? []),
    balance: vi.fn(async () => 0n),
  } satisfies WalletServices;
  Object.assign(f.services, { musegod, museChain: chain, wallets, ownership });
  function setOwner(id: number, owner: string) {
    owners.set(id, owner);
    records.get(id)!.owner = owner;
  }
  return {
    ...f,
    musegod,
    chain,
    ownership,
    wallets,
    records,
    owners,
    linked,
    gallery,
    week,
    foundings,
    setOwner,
  };
}
