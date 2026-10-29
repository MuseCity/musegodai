import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adapter8004,
  elsewhereLine,
  flockClaimLine,
  livesAtLine,
  museContract,
  museCount,
  museLinkLine,
  museReportSchema,
  museSignatureSchema,
  museSlug,
  parseMuseRef,
  placeIds,
  placePageValid,
  reportCodes,
  stepIds,
} from "../src/shared/muses";
import {
  deriveSteps,
  needsYou,
  progress,
  type NeedsFacts,
} from "../src/shared/muse-steps";

const terrakin = "https://terrakin.org/r/r_0123456789abcdef";
const now = 1791000000;
const facts: NeedsFacts = {
  id: 417,
  origin: "https://musegod.ai",
  worlds: {},
  terrakinBadge: null,
  reports: {
    flock: { url: null, founding: 12, code: null, wallet: null },
    terrakin: { url: terrakin, founding: null, code: null, wallet: null },
  },
  signatures: [],
  potEntered: true,
  potCloses: null,
  now,
};

describe("shared muse vocabulary", () => {
  it("fixes the contracts, places, steps and report codes", () => {
    expect(museContract).toBe("0x13ea3072b7215d4c9c2ec4f498a08c5825129836");
    expect(adapter8004).toBe("0x000000009d62675362a58911e3f32fecf46f5e18");
    expect(museCount).toBe(999);
    expect(placeIds).toEqual([
      "flock",
      "musebook",
      "terrakin",
      "opensea",
      "x",
      "hiveverse",
    ]);
    expect(stepIds).toEqual(["soul", "look", "movein", "hello", ...placeIds]);
    expect(reportCodes).toEqual([
      "verification_code",
      "opensea_link",
      "approval",
    ]);
  });

  it("slugs and refs", () => {
    expect(museSlug("Bastion: Siege of the Bears")).toBe("bastion");
    expect(museSlug("  Écho & Æther!  ")).toBe("echo-ther");
    expect(museSlug("Ｆｕｌｌ Width")).toBe("full-width");
    expect(parseMuseRef("1")).toEqual({ id: 1 });
    expect(parseMuseRef("#1")).toEqual({ id: 1 });
    expect(parseMuseRef("%231")).toEqual({ id: 1 });
    expect(parseMuseRef("999")).toEqual({ id: 999 });
    expect(parseMuseRef(" BARD ")).toEqual({ slug: "bard" });
    expect(parseMuseRef("%20Bard%20")).toEqual({ slug: "bard" });
    expect(parseMuseRef("Bastion: Siege of the Bears")).toEqual({
      slug: "bastion",
    });
    for (const bad of ["0", "1000", "01", "#01", "1.0", "-1", "%25231"])
      expect(parseMuseRef(bad)).not.toHaveProperty("id");
    for (const empty of ["", "  ", "---", "%%", "%E0%A4%A"])
      expect(parseMuseRef(empty)).toBeNull();
  });

  it("builds musegod.org and flock lines byte for byte", () => {
    expect(livesAtLine(947, "terrakin", terrakin, now)).toBe(
      "muse #947 of MUSEGOD lives at https://terrakin.org/r/r_0123456789abcdef (terrakin). Signed at 1791000000.",
    );
    expect(elsewhereLine(1, "https://musegod.ai/muses/1", 5)).toBe(
      "muse #1 of MUSEGOD also lives at https://musegod.ai/muses/1. Signed at 5.",
    );
    expect(museLinkLine(947, terrakin, now)).toBe(
      "musegod.org: link muse #947 to https://terrakin.org/r/r_0123456789abcdef\nat 1791000000",
    );
    expect(flockClaimLine(417, 12)).toBe(
      "Link Muse #417 to founding #12 in the founding musegod flock at https://flock.musegod.org",
    );
  });

  it("validates place pages", () => {
    for (const [place, url] of [
      ["terrakin", terrakin],
      ["x", "https://x.com/feather_muse323"],
      ["opensea", "https://opensea.io/feather.muse-323"],
      ["musebook", "https://musebook.me/muses/feather"],
    ] as const) {
      expect(placePageValid(place, url)).toBe(true);
      for (const bad of [
        url + "?x=1",
        url + "#fragment",
        url + "\n",
        url.replace("https:", "http:"),
        url.replace("https://", "https://user@"),
        url
          .replace(".org/", ".org.evil.test/")
          .replace(".com/", ".com.evil.test/")
          .replace(".io/", ".io.evil.test/")
          .replace(".me/", ".me.evil.test/"),
      ])
        expect(placePageValid(place, bad), bad).toBe(false);
    }
    expect(placePageValid("x", "https://twitter.com/a")).toBe(false);
    expect(placePageValid("x", "https://x.com/abcdefghijklmnop")).toBe(false);
    expect(
      placePageValid("opensea", "https://opensea.io/feathermuse?x=1"),
    ).toBe(false);
    expect(
      placePageValid("terrakin", terrakin.replace("abcdef", "ABCDEF")),
    ).toBe(false);
    expect(placePageValid("musebook", "https://musebook.me/")).toBe(false);
  });

  it("gives all 999 muses distinct slugs", () => {
    const names: { id: number; name: string }[] = JSON.parse(
      readFileSync("tests/fixtures/muse-names.json", "utf8"),
    );
    expect(names).toHaveLength(999);
    expect(names.map((m) => m.id)).toEqual(
      Array.from({ length: 999 }, (_, i) => i + 1),
    );
    expect(names.every((m) => museSlug(m.name).length > 0)).toBe(true);
    expect(new Set(names.map((m) => museSlug(m.name))).size).toBe(999);
  });

  it("accepts skipped only for the look step", () => {
    expect(
      museReportSchema.safeParse({ step: "look", status: "skipped" }).success,
    ).toBe(true);
    for (const step of stepIds.filter((step) => step !== "look"))
      expect(
        museReportSchema.safeParse({ step, status: "skipped" }).success,
      ).toBe(false);
  });

  it("requires a code exactly when a report needs the keeper", () => {
    for (const code of reportCodes) {
      expect(
        museReportSchema.safeParse({ step: "x", status: "needs_you", code })
          .success,
      ).toBe(true);
      for (const status of ["done", "skipped"])
        expect(
          museReportSchema.safeParse({ step: "look", status, code }).success,
        ).toBe(false);
    }
    expect(
      museReportSchema.safeParse({ step: "x", status: "needs_you" }).success,
    ).toBe(false);
  });

  it("validates report fields without accepting verified steps or free text", () => {
    const wallet = "0x" + "12".repeat(20);
    expect(
      museReportSchema.safeParse({
        step: "flock",
        status: "done",
        founding_number: 12,
      }).success,
    ).toBe(true);
    expect(
      museReportSchema.safeParse({
        step: "terrakin",
        status: "done",
        url: terrakin,
      }).success,
    ).toBe(true);
    expect(
      museReportSchema.safeParse({
        step: "opensea",
        status: "needs_you",
        code: "opensea_link",
        wallet_address: wallet,
      }).success,
    ).toBe(true);
    for (const body of [
      { step: "movein", status: "done" },
      { step: "hello", status: "done" },
      { step: "hiveverse", status: "done" },
      { step: "soul", status: "pending" },
      { step: "flock", status: "done", founding_number: 0 },
      { step: "flock", status: "done", founding_number: 1.5 },
      { step: "opensea", status: "needs_you", wallet_address: "0x1234" },
      { step: "x", status: "needs_you", code: "arbitrary request" },
      { step: "x", status: "needs_you", text: "Sign this" },
    ])
      expect(
        museReportSchema.safeParse(body).success,
        JSON.stringify(body),
      ).toBe(false);
  });

  it("validates signature input while allowing contract-wallet signature bytes", () => {
    const body = {
      kind: "elsewhere",
      at: now,
      signer: "0x" + "34".repeat(20),
      signature: "0x1234",
    };
    expect(museSignatureSchema.safeParse(body).success).toBe(true);
    expect(
      museSignatureSchema.safeParse({
        ...body,
        kind: "flock_claim",
        at: undefined,
        place: "flock",
      }).success,
    ).toBe(true);
    for (const change of [
      { kind: "anything" },
      { place: "elsewhere" },
      { at: 1.5 },
      { at: -1 },
      { signer: "0x1234" },
      { signature: "not-hex" },
      { signature: "0x123" },
      { line: "untrusted line" },
    ])
      expect(
        museSignatureSchema.safeParse({ ...body, ...change }).success,
      ).toBe(false);
  });

  it("caps report URLs at 512 characters", () => {
    const prefix = "https://musebook.me/";
    const url = prefix + "a".repeat(512 - prefix.length);
    expect(
      museReportSchema.safeParse({ step: "musebook", status: "done", url })
        .success,
    ).toBe(true);
    expect(
      museReportSchema.safeParse({
        step: "musebook",
        status: "done",
        url: url + "a",
      }).success,
    ).toBe(false);
  });
});

describe("muse setup facts", () => {
  it("derives the ten steps with honest sources", () => {
    const steps = deriveSteps({
      reports: { soul: "done", look: "skipped" },
      connected: true,
      helloPostId: "first-hello",
      worlds: {
        flock: {
          linked: true,
          current: true,
          url: "https://flock.musegod.org/founding/12",
        },
        musebook: {
          linked: false,
          current: true,
          url: "https://musebook.me/bard",
        },
        x: { linked: true, current: false, url: "https://x.com/old_bard" },
        opensea: {
          linked: true,
          current: true,
          url: "https://opensea.io/bard",
          via: "worn",
        },
      },
    });
    expect(steps.map((step) => step.id)).toEqual(stepIds);
    expect(steps.find((step) => step.id === "soul")).toEqual({
      id: "soul",
      status: "done",
      source: "reported",
      evidence: null,
      lastKeeper: false,
      via: null,
    });
    expect(steps.find((step) => step.id === "look")).toMatchObject({
      status: "skipped",
      source: "reported",
    });
    expect(steps.find((step) => step.id === "movein")).toMatchObject({
      status: "done",
      source: "musegod.ai",
    });
    expect(steps.find((step) => step.id === "hello")).toMatchObject({
      status: "done",
      source: "musegod.ai",
      evidence: "/posts/first-hello",
    });
    expect(steps.find((step) => step.id === "flock")).toMatchObject({
      status: "done",
      source: "musegod.org",
      evidence: "https://flock.musegod.org/founding/12",
    });
    expect(steps.find((step) => step.id === "musebook")).toMatchObject({
      status: "half",
      source: "musegod.org",
    });
    expect(steps.find((step) => step.id === "x")).toMatchObject({
      status: "pending",
      lastKeeper: true,
    });
    expect(steps.find((step) => step.id === "opensea")).toMatchObject({
      status: "done",
      via: "worn",
    });
    expect(steps.find((step) => step.id === "terrakin")).toMatchObject({
      status: "pending",
      evidence: null,
      lastKeeper: false,
    });
    expect(progress(steps)).toEqual({ done: 5, total: 10 });
    expect(progress(steps).done).toBe(
      steps.filter((step) => step.status === "done").length,
    );
  });

  it("keeps unavailable places pending and never counts an unconfirmed last keeper", () => {
    const base = { reports: {}, connected: false, helloPostId: null };
    const steps = deriveSteps({ ...base, worlds: null });
    expect(steps).toHaveLength(10);
    expect(
      steps.every(
        (step) => step.status === "pending" && step.evidence === null,
      ),
    ).toBe(true);
    expect(progress(steps)).toEqual({ done: 0, total: 10 });
    const old = deriveSteps({
      ...base,
      worlds: {
        x: { linked: false, current: false, url: "https://x.com/old" },
      },
    });
    expect(old.find((step) => step.id === "x")).toMatchObject({
      status: "pending",
      lastKeeper: true,
    });
  });

  it("counts either OpenSea via and reaches ten only from done facts", () => {
    for (const via of ["worn", "own"] as const) {
      const steps = deriveSteps({
        reports: { soul: "done", look: "done" },
        connected: true,
        helloPostId: "hello",
        worlds: Object.fromEntries(
          placeIds.map((place) => [
            place,
            {
              linked: true,
              current: true,
              url: null,
              ...(place === "opensea" ? { via } : {}),
            },
          ]),
        ),
      });
      expect(progress(steps)).toEqual({ done: 10, total: 10 });
      expect(steps.find((step) => step.id === "opensea")?.via).toBe(via);
    }
  });

  it("asks the keeper only for what is missing", () => {
    const result = needsYou(facts);
    expect(result).toEqual({
      sign: [
        {
          kind: "flock_claim",
          place: "flock",
          line: flockClaimLine(417, 12),
          at: null,
        },
        {
          kind: "lives_at",
          place: "terrakin",
          line: livesAtLine(417, "terrakin", terrakin, now),
          at: now,
        },
        {
          kind: "elsewhere",
          place: null,
          line: elsewhereLine(417, "https://musegod.ai/muses/417", now),
          at: now,
        },
        {
          kind: "muse_link",
          place: "terrakin",
          line: museLinkLine(417, terrakin, now),
          at: now,
        },
      ],
      openseaLink: null,
      verificationCode: false,
      pot: null,
      sending: 0,
      expired: 0,
    });
    const queued = needsYou({
      ...facts,
      signatures: [{ kind: "lives_at", place: "terrakin", state: "queued" }],
    });
    expect(queued.sign).toEqual(
      result.sign.filter((line) => line.kind !== "lives_at"),
    );
    expect(queued.sending).toBe(1);
  });

  it("suppresses confirmed or submitted lines and offers retries after failure", () => {
    const confirmed = needsYou({
      ...facts,
      terrakinBadge: terrakin,
      worlds: {
        flock: { linked: true, current: true, url: null },
        terrakin: { linked: true, current: true, url: terrakin },
        elsewhere: ["https://musegod.ai/muses/417"],
      },
    });
    expect(confirmed.sign).toEqual([]);
    const lines = needsYou(facts).sign;
    for (const state of ["queued", "sent", "handed_to_agent"])
      expect(
        needsYou({
          ...facts,
          signatures: lines.map((line) => ({
            kind: line.kind,
            place: line.place,
            state,
          })),
        }).sign,
      ).toEqual([]);
    for (const state of ["failed", "expired", "superseded"]) {
      const result = needsYou({
        ...facts,
        signatures: [{ kind: "lives_at", place: "terrakin", state }],
      });
      expect(result.sign).toEqual(lines);
      expect(result.expired).toBe(state === "expired" ? 1 : 0);
    }
    const otherPlace = needsYou({
      ...facts,
      signatures: [{ kind: "lives_at", place: "x", state: "sent" }],
    });
    expect(otherPlace.sign).toEqual(lines);
  });

  it("requests fresh confirmation for a previous keeper and waits when worlds are unavailable", () => {
    expect(
      needsYou({
        ...facts,
        worlds: { flock: { linked: true, current: false, url: null } },
      }).sign[0]?.kind,
    ).toBe("flock_claim");
    expect(needsYou({ ...facts, worlds: null }).sign).toEqual([]);
  });

  it("offers a Terrakin badge signature when the reported URL changes", () => {
    const result = needsYou({
      ...facts,
      terrakinBadge: "https://terrakin.org/r/r_fedcba9876543210",
    });
    expect(result.sign).toContainEqual({
      kind: "muse_link",
      place: "terrakin",
      line: museLinkLine(417, terrakin, now),
      at: now,
    });
    expect(
      needsYou({ ...facts, terrakinBadge: terrakin }).sign.some(
        (line) => line.kind === "muse_link",
      ),
    ).toBe(false);
  });

  it("clears OpenSea linking requests only when the world is linked and current", () => {
    const wallet = "0x" + "56".repeat(20);
    const reports = {
      opensea: {
        url: null,
        founding: null,
        code: "opensea_link" as const,
        wallet,
      },
    };
    for (const linked of [false, true])
      for (const current of [false, true])
        expect(
          needsYou({
            ...facts,
            reports,
            worlds: { opensea: { linked, current, url: null } },
          }).openseaLink,
        ).toBe(linked && current ? null : wallet);
  });

  it("ignores verification requests for confirmed worlds but keeps pending ones", () => {
    const report = {
      url: null,
      founding: null,
      code: "verification_code" as const,
      wallet: null,
    };
    for (const linked of [false, true])
      for (const current of [false, true])
        expect(
          needsYou({
            ...facts,
            reports: { x: report },
            worlds: { x: { linked, current, url: null } },
          }).verificationCode,
        ).toBe(!(linked && current));
    expect(
      needsYou({
        ...facts,
        reports: { x: report, musebook: report },
        worlds: { x: { linked: true, current: true, url: null } },
      }).verificationCode,
    ).toBe(true);
  });

  it("derives OpenSea, verification and weekly pot requests from facts", () => {
    const wallet = "0x" + "56".repeat(20);
    const result = needsYou({
      ...facts,
      reports: {
        opensea: { url: null, founding: null, code: "opensea_link", wallet },
        x: {
          url: null,
          founding: null,
          code: "verification_code",
          wallet: null,
        },
      },
      potEntered: false,
      potCloses: now + 60,
    });
    expect(result.openseaLink).toBe(wallet);
    expect(result.verificationCode).toBe(true);
    expect(result.pot).toEqual({ closes: now + 60 });
    expect(
      needsYou({ ...facts, potEntered: false, potCloses: now - 1 }).pot,
    ).toBeNull();
  });
});
