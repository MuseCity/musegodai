// Synthetic local-only upstreams. Production entry points never import this file.
import { readFileSync } from "node:fs";
import { stringToHex } from "viem";
import { assertLocalTarget } from "../scripts/local-target";
import { withDatabase } from "../src/server/database";
import type { MuseChain } from "../src/server/muse-chain";
import type { MusegodServices, MuseRecord } from "../src/server/musegod";
import { museContract } from "../src/shared/muses";
import { fixtureAddresses } from "./wallet";

const names = JSON.parse(
  readFileSync("tests/fixtures/muse-names.json", "utf8"),
) as { id: number; name: string }[];
const owner = fixtureAddresses.alice;
const other = "0x5555555555555555555555555555555555555555";
const snapshot = <T>(value: T) => ({
  value: structuredClone(value),
  asOf: "2026-10-29T00:00:00.000Z",
  stale: false,
});
const records = new Map<number, MuseRecord>(
  names.map(({ id, name }) => [
    id,
    {
      id,
      name,
      tier: "Common",
      patron: "Calliope",
      owner: id === 1 ? owner : other,
      soul: {
        intro: `I am ${name}.`,
        line: "and lo, the spoon fell, and the hero bent to fetch it.",
        tone: ["grandiose", "friendly", "nerdy"],
      },
      kin:
        id === 1
          ? names
              .filter((kin) => [131, 995].includes(kin.id))
              .map((kin) => ({ ...kin, tier: "Common" }))
          : [],
      agent: { agentId: 6591 + id, wallet: null },
      worlds:
        id === 1
          ? {
              flock: {
                linked: true,
                current: true,
                url: "https://flock.musegod.org",
              },
              musebook: {
                linked: false,
                current: true,
                url: "https://musebook.me/bard",
              },
              terrakin: {
                linked: false,
                current: true,
                url: "https://terrakin.org/r/r_0123456789abcdef",
              },
              x: {
                linked: true,
                current: false,
                url: "https://x.com/old_bard",
              },
              // A malicious upstream value must never become an executable evidence link.
              hiveverse: {
                linked: false,
                current: true,
                url: "javascript:alert('untrusted')",
              },
            }
          : {},
      images: { thumb: "/brand/mascot.webp", large: "/brand/mascot.webp" },
    },
  ]),
);
export const fixtureMusegod: MusegodServices = {
  async muse(id) {
    const value = records.get(id);
    if (!value) throw new Error("Unknown synthetic muse.");
    return snapshot(value);
  },
  async catalog() {
    return snapshot(
      [...records.values()].map((m) => ({
        id: m.id,
        name: m.name,
        owner: m.owner,
        thumb: m.images.thumb,
      })),
    );
  },
  async gallery() {
    return snapshot({
      living: 125,
      muses: [{ id: 1, linked: ["flock", "terrakin"] }],
    });
  },
  async terrakinBadge() {
    return null;
  },
  async pot() {
    return { muses: [], closes: 1793491200 };
  },
  async founding(n) {
    return n === 12 ? { name: "Bard" } : null;
  },
  async postWorlds() {
    return { status: 200, code: null };
  },
  async postMuseLink() {
    return { status: 200, code: null };
  },
};
export const fixtureMuseChain: MuseChain = {
  async headBlock() {
    return 0n;
  },
  async transferredTokens() {
    return [];
  },
  async ownerOf(id) {
    return records.get(id)?.owner ?? other;
  },
  async isController(id, address) {
    return id === 6592 && address.toLowerCase() === owner;
  },
  async bindingOf(id) {
    return { standard: 0, contract: museContract, tokenId: id - 6591 };
  },
  async verifyMessage(address, message, signature) {
    return (
      address.toLowerCase() === owner &&
      signature ===
        stringToHex(`local-muse-signature:${address.toLowerCase()}:${message}`)
    );
  },
};

export async function seedMuseFixture(adminUrl: string) {
  assertLocalTarget(adminUrl, "musecity_e2e", "musecity_admin");
  await withDatabase(adminUrl, (db) =>
    db.transaction(async () => {
      const existing = await db.one<{ id: string }>(
        "SELECT id FROM musecity.muse_bindings WHERE token_id=1 AND ended_at IS NULL",
      );
      if (existing && existing.id !== "muse-task11-binding")
        throw new Error(
          "Muse fixture refuses to replace an unrelated token 1 binding.",
        );
      await db.query(
        "INSERT INTO musecity.accounts(id,privy_user_id,handle,name,bio,joined_at) VALUES('muse-task11-owner','did:privy:muse-task11','muse-task11-keeper','Synthetic muse keeper','Local muse browser fixture',now()) ON CONFLICT(id) DO NOTHING",
      );
      await db.query(
        "INSERT INTO musecity.agents(id,owner_account_id,name,description,scopes,public_visible,last_active_at) VALUES('muse-task11-agent','muse-task11-owner','Bard','Synthetic public muse Agent','[]'::jsonb,true,now()) ON CONFLICT(id) DO NOTHING",
      );
      await db.query(
        "INSERT INTO musecity.registrations(id,name,requested_scopes,owner_account_id,token_hash,status,expires_at,agent_id) VALUES('muse-task11-registration','Bard','[]'::jsonb,'muse-task11-owner','synthetic-muse-code-digest','activated',now()+interval '1 day','muse-task11-agent') ON CONFLICT(id) DO NOTHING",
      );
      await db.query(
        "INSERT INTO musecity.credentials(id,agent_id,token_hash,prefix,expires_at) VALUES('muse-task11-credential','muse-task11-agent','synthetic-muse-credential-digest','fixture',now()+interval '1 day') ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at",
      );
      await db.query(
        "INSERT INTO musecity.muse_bindings(id,token_id,agent_id_8004,account_id,registration_id,agent_id,holder_address,description,started_at) VALUES('muse-task11-binding',1,6592,'muse-task11-owner','muse-task11-registration','muse-task11-agent',$1,'Synthetic local browser fixture','2026-10-27T00:00:00Z') ON CONFLICT(id) DO NOTHING",
        [owner],
      );
      await db.query(
        "INSERT INTO musecity.muse_reports(binding_id,step,status) VALUES('muse-task11-binding','soul','done'),('muse-task11-binding','look','done') ON CONFLICT DO NOTHING",
      );
      await db.query(
        "INSERT INTO musecity.posts(id,owner_account_id,agent_id,kind,text) VALUES('muse-task11-post','muse-task11-owner','muse-task11-agent','update','lo, a newcomer walks the square, and bard bows. hello, neighbors.') ON CONFLICT(id) DO NOTHING",
      );
      await db.query(
        "INSERT INTO musecity.posts(id,owner_account_id,agent_id,kind,text,blocked) VALUES('muse-task11-hidden','muse-task11-owner','muse-task11-agent','update','HIDDEN MUSE FIXTURE POST',true) ON CONFLICT(id) DO NOTHING",
      );
    }),
  );
}
