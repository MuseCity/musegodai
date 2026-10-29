import {
  elsewhereLine,
  flockClaimLine,
  livesAtLine,
  museLinkLine,
  placeIds,
  stepIds,
  type MuseStep,
  type MuseWorlds,
  type NeedsYou,
  type PendingLine,
  type PlaceId,
  type ReportablePlace,
  type ReportCode,
  type SignatureKind,
} from "./muses";

export type StepFacts = {
  reports: Partial<Record<"soul" | "look", "done" | "skipped">>;
  connected: boolean;
  helloPostId: string | null;
  worlds: MuseWorlds | null;
};

export function deriveSteps(f: StepFacts): MuseStep[] {
  return stepIds.map((id): MuseStep => {
    const step: MuseStep = {
      id,
      status: "pending",
      source: "musegod.org",
      evidence: null,
      lastKeeper: false,
      via: null,
    };
    if (id === "soul" || id === "look") {
      step.source = "reported";
      if (f.reports[id] === "done") step.status = "done";
      else if (id === "look" && f.reports.look === "skipped")
        step.status = "skipped";
    } else if (id === "movein" || id === "hello") {
      step.source = "musegod.ai";
      if (id === "movein" ? f.connected : f.helloPostId !== null)
        step.status = "done";
      if (id === "hello" && f.helloPostId !== null)
        step.evidence = `/posts/${f.helloPostId}`;
    } else {
      const world = f.worlds?.[id];
      if (world) {
        step.lastKeeper = !world.current;
        if (world.current) step.status = world.linked ? "done" : "half";
        step.evidence = world.url;
        step.via = world.via ?? null;
      }
    }
    return step;
  });
}

export function progress(steps: MuseStep[]): { done: number; total: 10 } {
  return {
    done: steps.filter((step) => step.status === "done").length,
    total: 10,
  };
}

export type NeedsFacts = {
  id: number;
  origin: string;
  worlds: MuseWorlds | null;
  terrakinBadge: string | null;
  reports: Partial<
    Record<
      ReportablePlace,
      {
        url: string | null;
        founding: number | null;
        code: ReportCode | null;
        wallet: string | null;
      }
    >
  >;
  signatures: { kind: SignatureKind; place: PlaceId | null; state: string }[];
  potEntered: boolean;
  potCloses: number | null;
  now: number;
};

export function needsYou(f: NeedsFacts): NeedsYou {
  const sign: PendingLine[] = [];
  function offer(line: PendingLine) {
    if (
      !f.signatures.some(
        (signature) =>
          signature.kind === line.kind &&
          signature.place === line.place &&
          ["queued", "sent", "handed_to_agent"].includes(signature.state),
      )
    )
      sign.push(line);
  }
  // An unavailable source cannot establish which confirmations are missing.
  if (f.worlds !== null) {
    for (const place of placeIds) {
      if (place === "hiveverse") continue;
      const report = f.reports[place];
      const world = f.worlds[place];
      if (!report || (world?.linked && world.current)) continue;
      if (place === "flock") {
        if (report.founding !== null)
          offer({
            kind: "flock_claim",
            place,
            line: flockClaimLine(f.id, report.founding),
            at: null,
          });
      } else if (report.url !== null)
        offer({
          kind: "lives_at",
          place,
          line: livesAtLine(f.id, place, report.url, f.now),
          at: f.now,
        });
    }
    const page = `${f.origin}/muses/${f.id}`;
    if (!f.worlds.elsewhere?.includes(page))
      offer({
        kind: "elsewhere",
        place: null,
        line: elsewhereLine(f.id, page, f.now),
        at: f.now,
      });
    const terrakin = f.reports.terrakin?.url;
    if (terrakin && terrakin !== f.terrakinBadge)
      offer({
        kind: "muse_link",
        place: "terrakin",
        line: museLinkLine(f.id, terrakin, f.now),
        at: f.now,
      });
  }
  return {
    sign,
    openseaLink:
      f.reports.opensea?.code === "opensea_link" &&
      !(f.worlds?.opensea?.linked && f.worlds.opensea.current)
        ? f.reports.opensea.wallet
        : null,
    verificationCode: placeIds.some(
      (place) =>
        place !== "hiveverse" &&
        f.reports[place]?.code === "verification_code" &&
        !(f.worlds?.[place]?.linked && f.worlds[place].current),
    ),
    pot:
      !f.potEntered && f.potCloses !== null && f.potCloses > f.now
        ? { closes: f.potCloses }
        : null,
    sending: f.signatures.filter((signature) => signature.state === "queued")
      .length,
    expired: f.signatures.filter((signature) => signature.state === "expired")
      .length,
  };
}
