import { z } from "zod";
import type { AgentConnectionStatus } from "./contracts";

export const museContract = "0x13ea3072b7215d4c9c2ec4f498a08c5825129836";
export const adapter8004 = "0x000000009d62675362a58911e3f32fecf46f5e18";
export const museCount = 999;
export const placeIds = [
  "flock",
  "musebook",
  "terrakin",
  "opensea",
  "x",
  "hiveverse",
] as const;
export type PlaceId = (typeof placeIds)[number];
export type ReportablePlace = Exclude<PlaceId, "hiveverse">;
export const stepIds = [
  "soul",
  "look",
  "movein",
  "hello",
  ...placeIds,
] as const;
export type StepId = (typeof stepIds)[number];
export const reportCodes = [
  "verification_code",
  "opensea_link",
  "approval",
] as const;
export type ReportCode = (typeof reportCodes)[number];
export type SignatureKind =
  "lives_at" | "elsewhere" | "muse_link" | "flock_claim";

export function museSlug(name: string): string {
  return name
    .split(":", 1)[0]
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseMuseRef(
  ref: string,
): { id: number } | { slug: string } | null {
  let value: string;
  try {
    value = decodeURIComponent(ref).trim();
  } catch {
    return null;
  }
  if (/^#?[1-9]\d*$/.test(value)) {
    const id = Number(value.replace(/^#/, ""));
    if (id <= museCount) return { id };
  }
  const slug = museSlug(value);
  return slug ? { slug } : null;
}

export function placePageValid(
  place: "musebook" | "terrakin" | "opensea" | "x",
  url: string,
): boolean {
  const patterns = {
    terrakin: /^https:\/\/terrakin\.org\/r\/r_[0-9a-f]{16}$/,
    musebook: /^https:\/\/musebook\.me\/[^\s?#]+$/,
    opensea: /^https:\/\/opensea\.io\/[A-Za-z0-9_.-]{1,64}$/,
    x: /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/,
  };
  return !/\s/.test(url) && patterns[place].test(url);
}

export function livesAtLine(
  id: number,
  place: Exclude<ReportablePlace, "flock">,
  url: string,
  at: number,
): string {
  return `muse #${id} of MUSEGOD lives at ${url} (${place}). Signed at ${at}.`;
}

export function elsewhereLine(id: number, url: string, at: number): string {
  return `muse #${id} of MUSEGOD also lives at ${url}. Signed at ${at}.`;
}

export function museLinkLine(id: number, url: string, at: number): string {
  return `musegod.org: link muse #${id} to ${url}\nat ${at}`;
}

export function flockClaimLine(id: number, founding: number): string {
  return `Link Muse #${id} to founding #${founding} in the founding musegod flock at https://flock.musegod.org`;
}

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const museReportSchema = z
  .object({
    step: z.enum([
      "soul",
      "look",
      "flock",
      "musebook",
      "terrakin",
      "opensea",
      "x",
    ]),
    status: z.enum(["done", "needs_you", "skipped"]),
    url: z.string().optional(),
    founding_number: z.number().int().positive().optional(),
    wallet_address: addressSchema.optional(),
    code: z.enum(reportCodes).optional(),
  })
  .strict()
  .refine((report) => report.status !== "skipped" || report.step === "look", {
    path: ["status"],
    message: "Only the look step may be skipped.",
  });
export type MuseReport = z.infer<typeof museReportSchema>;
export const museSignatureSchema = z
  .object({
    kind: z.enum(["lives_at", "elsewhere", "muse_link", "flock_claim"]),
    place: z.enum(placeIds).optional(),
    at: z.number().int().nonnegative().optional(),
    signer: addressSchema,
    signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  })
  .strict();
export type MuseSignature = z.infer<typeof museSignatureSchema>;

export type StepStatus = "done" | "half" | "pending" | "skipped";
export type StepSource = "reported" | "musegod.ai" | "musegod.org";
export type MuseStep = {
  id: StepId;
  status: StepStatus;
  source: StepSource;
  evidence: string | null;
  lastKeeper: boolean;
  via: "worn" | "own" | null;
};
export type MuseWorlds = Partial<
  Record<
    PlaceId,
    {
      linked: boolean;
      current: boolean;
      url: string | null;
      via?: "worn" | "own";
    }
  >
> & { elsewhere?: string[] };
export type MuseSummary = {
  id: number;
  name: string;
  tier: string;
  patron: string;
  line: string | null;
  intro: string | null;
  tone: string[];
  kin: { id: number; name: string; tier: string }[];
  images: { thumb: string; large: string };
  page: string;
  opensea: string;
};
export type MuseView = {
  muse: MuseSummary;
  keeper: string;
  agent: { id: string; name: string } | null;
  startedAt: string | null;
  steps: MuseStep[];
  progress: { done: number; total: 10 };
  asOf: string | null;
  placesAvailable: boolean;
};
export type DirectoryItem = {
  id: number;
  name: string;
  thumb: string;
  done: number;
  awake: boolean;
  started: boolean;
};
export type MuseDirectory = {
  items: DirectoryItem[];
  counts: { awake: number; living: number; complete: number };
};
export type PendingLine = {
  kind: SignatureKind;
  place: PlaceId | null;
  line: string;
  at: number | null;
};
export type NeedsYou = {
  sign: PendingLine[];
  openseaLink: string | null;
  verificationCode: boolean;
  pot: { closes: number } | null;
  sending: number;
  expired: number;
};
export type KeeperView = {
  id: number;
  controllers: string[];
  agentLimitReached: boolean;
  binding: {
    startedAt: string;
    connection: AgentConnectionStatus | null;
  } | null;
  reports: {
    step: StepId;
    status: "done" | "needs_you" | "skipped";
    at: string;
  }[];
  needsYou: NeedsYou;
};
export type StartResult = {
  connectionId: string;
  otp: string;
  expiresAt: string;
  line: string;
};
