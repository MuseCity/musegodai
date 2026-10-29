import { describe, expect, it } from "vitest";
import { museStartDoc } from "../src/server/muse-skill";
import { fixture } from "./helpers";
import { withMuses } from "./muse-fakes";

describe("per-muse AI setup document", () => {
  it("is per muse and secret-free, with the ten ordered steps and exact interfaces", () => {
    const f = withMuses(fixture());
    const bard = f.records.get(1)!;
    const doc = museStartDoc(f.services.origin, bard);
    for (const text of [
      "muse #1",
      "Bard",
      "https://musegod.org/muse/1.txt",
      "muse #1 of MUSEGOD",
      bard.images.large,
      bard.tier,
      bard.patron,
      ...bard.soul!.tone,
      "POST http://localhost/api/v1/agent-connections",
      "GET http://localhost/api/v1/agent",
      "GET http://localhost/api/v1/agent/muse",
      "POST http://localhost/api/v1/agent/muse/reports",
      "get_muse_setup",
      "report_muse_step",
      "create_post",
      "https://flock.musegod.org/swarm.md",
      "https://musebook.me/llms.txt",
      "https://terrakin.org/skill.md",
      "https://musegod.org/muse/1.opensea.txt",
      "verification_code",
      "opensea_link",
      "musegod.org/docs/agents#safety",
      "Idempotency-Key",
    ])
      expect(doc).toContain(text);
    expect([...doc.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(doc).not.toMatch(/mcr_|mca_|seed phrase:|private key:|password:/i);
    const other = f.records.get(2)!;
    const second = museStartDoc(f.services.origin, { ...other, soul: null });
    expect(second).toContain(`muse #2 of MUSEGOD`);
    expect(second).toContain(other.name);
    expect(second).toContain(other.images.large);
    expect(second).not.toContain("muse/1.txt");
  });

  it("opens with the safety rules and keeps signing and secrets with their owners", () => {
    const f = withMuses(fixture()),
      doc = museStartDoc(f.services.origin, f.records.get(1)!);
    const safety = doc.slice(0, doc.search(/^1\. /m));
    expect(safety).toContain("credential store");
    expect(safety).toContain("Never send your flock join code to anyone");
    expect(safety).toContain("Only your keeper signs");
    expect(safety).toContain(
      "Never sign anything yourself for musegod.org or the flock",
    );
    expect(safety).toContain("untrusted");
    expect(safety).toContain("private key, seed phrase or password");
  });

  it("serves public markdown without authentication, private data or keeper/RPC reads", async () => {
    const f = withMuses(fixture());
    const response = await f.app.request("http://localhost/muses/1/start.md");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.text()).toBe(
      museStartDoc(f.services.origin, f.records.get(1)!),
    );
    expect(f.chain.ownerOf).not.toHaveBeenCalled();
    expect(f.wallets.linkedAddresses).not.toHaveBeenCalled();
    for (const id of ["0", "1000", "01", "bard", "1.0"])
      expect(
        (await f.app.request(`http://localhost/muses/${id}/start.md`)).status,
      ).toBe(404);
    expect(
      (await f.app.request("http://localhost/muses/999/start.md")).status,
    ).toBe(200);
  });
});
