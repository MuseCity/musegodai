import type { Interactions } from "./interactions";
import { z } from "zod";

export const workTypes = ["website", "video", "image", "article"] as const;
export type WorkType = (typeof workTypes)[number];
export const typeLabels: Record<WorkType, string> = {
  website: "Websites",
  video: "Videos",
  image: "Images",
  article: "Articles",
};
export const topics = [
  { id: "ai-tools", name: "AI tools" },
  { id: "development", name: "Development" },
  { id: "design", name: "Design" },
  { id: "tutorials", name: "Tutorials" },
  { id: "games", name: "Games" },
  { id: "experiments", name: "Experiments" },
];
export const defaultTabs = ["latest", "following", "sites"];
export const maxFeedTabs = 21;
export type Topic = { id: string; name: string };
export const createTagSchema = z
  .object({
    name: z
      .string()
      .transform((name) => name.normalize("NFKC").trim().replace(/\s+/g, " "))
      .pipe(z.string().min(1).max(40))
      .refine(
        (name) => /[\p{L}\p{N}]/u.test(name) && !/[\p{Cc}\p{Cf}]/u.test(name),
        "Use a readable tag name.",
      )
      .refine(
        (name) => !defaultTabs.includes(name.toLowerCase()),
        "Latest, Following and Sites are reserved tabs.",
      ),
  })
  .strict();
export const feedPreferencesSchema = z
  .object({
    tabs: z
      .array(z.string())
      .min(defaultTabs.length)
      .max(maxFeedTabs)
      .refine(
        (tabs) =>
          defaultTabs.every((tab, i) => tabs[i] === tab) &&
          new Set(tabs).size === tabs.length,
        "Latest, Following and Sites must stay first; tabs must be unique.",
      ),
  })
  .strict();
const tagIdsSchema = z
  .array(z.string())
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length)
  .default([]);
export const scopes = [
  "content:read",
  "content:write",
  "content:publish",
  "community:post",
  "community:reply",
  "community:notifications",
] as const;
export type Scope = (typeof scopes)[number];
export const draftScopes: Scope[] = ["content:read", "content:write"];
export const publishScopes: Scope[] = [...draftScopes, "content:publish"];
export const scopesSchema = z
  .array(z.enum(scopes))
  .refine(
    (s) =>
      new Set(s).size === s.length && draftScopes.every((v) => s.includes(v)),
    "Select draft or publishing permission",
  );
export const safeUrl = (value: string) => {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      h.includes(".") &&
      !/(^localhost$|\.localhost$|\.local$|\.internal$|^127\.|^0\.|^10\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.)/.test(
        h,
      ) &&
      !h.includes(":")
    );
  } catch {
    return false;
  }
};
export const urlSchema = z
  .string()
  .max(2048)
  .refine(safeUrl, "Use a public HTTPS URL without embedded credentials");
export type ArticleNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: ArticleNode[];
};
const nodes = new Set([
  "doc",
  "paragraph",
  "heading",
  "text",
  "hardBreak",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "image",
]);
const marks = new Set(["bold", "italic", "strike", "code", "link"]);
export function articleText(node: ArticleNode): string {
  return (
    node.text ??
    node.content?.map(articleText).join(node.type === "paragraph" ? "" : " ") ??
    ""
  );
}
export function articleMedia(node: ArticleNode): string[] {
  return [
    ...(node.type === "image" && typeof node.attrs?.mediaId === "string"
      ? [node.attrs.mediaId]
      : []),
    ...(node.content?.flatMap(articleMedia) ?? []),
  ];
}
export function validArticle(value: unknown): value is ArticleNode {
  if (
    !value ||
    typeof value !== "object" ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 512 * 1024
  )
    return false;
  let count = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (
      ++count > 10000 ||
      depth > 12 ||
      !v ||
      typeof v !== "object" ||
      Array.isArray(v)
    )
      return false;
    const n = v as ArticleNode;
    if (
      !nodes.has(n.type) ||
      Object.keys(n).some(
        (k) => !["type", "text", "attrs", "marks", "content"].includes(k),
      )
    )
      return false;
    if (
      n.text !== undefined &&
      (n.type !== "text" || typeof n.text !== "string")
    )
      return false;
    if (n.type === "text" && (typeof n.text !== "string" || n.content))
      return false;
    if (n.attrs && (Array.isArray(n.attrs) || typeof n.attrs !== "object"))
      return false;
    const allowedAttrs =
      n.type === "image"
        ? ["mediaId", "alt"]
        : n.type === "heading"
          ? ["level"]
          : n.type === "orderedList"
            ? ["start"]
            : n.type === "codeBlock"
              ? ["language"]
              : [];
    if (Object.keys(n.attrs ?? {}).some((k) => !allowedAttrs.includes(k)))
      return false;
    if (
      n.type === "image" &&
      (typeof n.attrs?.mediaId !== "string" ||
        !/^med_[a-z0-9-]+$/.test(n.attrs.mediaId) ||
        (n.attrs.alt !== undefined && typeof n.attrs.alt !== "string"))
    )
      return false;
    if (n.type === "heading" && ![2, 3].includes(Number(n.attrs?.level)))
      return false;
    if (
      n.type === "orderedList" &&
      n.attrs?.start !== undefined &&
      (!Number.isInteger(n.attrs.start) || Number(n.attrs.start) < 1)
    )
      return false;
    if (
      n.marks &&
      (!Array.isArray(n.marks) ||
        n.marks.some(
          (m) =>
            !m ||
            typeof m !== "object" ||
            !marks.has(m.type) ||
            Object.keys(m).some((k) => !["type", "attrs"].includes(k)) ||
            (m.type === "link"
              ? typeof m.attrs?.href !== "string" ||
                !safeUrl(m.attrs.href) ||
                Object.keys(m.attrs).some((k) => k !== "href")
              : m.attrs && Object.keys(m.attrs).length > 0),
        ))
    )
      return false;
    if (
      n.content &&
      (!Array.isArray(n.content) || !n.content.every((c) => walk(c, depth + 1)))
    )
      return false;
    if (["image", "hardBreak", "horizontalRule"].includes(n.type) && n.content)
      return false;
    if (
      n.type === "codeBlock" &&
      (n.content?.some(
        (c) => c.type !== "text" || (c.marks?.length ?? 0) > 0,
      ) ||
        (n.attrs?.language !== undefined &&
          typeof n.attrs.language !== "string"))
    )
      return false;
    if (
      ["blockquote", "listItem"].includes(n.type) &&
      n.content?.some((c) =>
        ["doc", "text", "hardBreak", "listItem"].includes(c.type),
      )
    )
      return false;
    if (n.type === "listItem" && n.content?.[0]?.type !== "paragraph")
      return false;
    if (
      n.type === "doc" &&
      (depth !== 0 ||
        n.content?.some((c) => ["text", "listItem", "doc"].includes(c.type)))
    )
      return false;
    if (
      ["bulletList", "orderedList"].includes(n.type) &&
      n.content?.some((c) => c.type !== "listItem")
    )
      return false;
    if (
      ["paragraph", "heading"].includes(n.type) &&
      n.content?.some((c) => !["text", "hardBreak"].includes(c.type))
    )
      return false;
    return true;
  };
  return (
    (value as ArticleNode).type === "doc" &&
    walk(value, 0) &&
    articleText(value as ArticleNode).length <= 50000
  );
}
export const articleSchema = z.custom<ArticleNode>(
  validArticle,
  "Invalid or unsupported article structure",
);
export const workSchema = z
  .object({
    type: z.enum(workTypes),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(5000).default(""),
    aiDeclaration: z.boolean().optional(),
    aiTools: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
    tagIds: tagIdsSchema,
    websiteUrl: urlSchema.optional(),
    videoUrl: urlSchema.optional(),
    coverMediaId: z.string().optional(),
    imageMediaIds: z.array(z.string()).min(1).max(9).optional(),
    articleDocument: articleSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (v.type === "website" && !v.websiteUrl)
      issue("A website URL is required");
    if (v.type === "video" && !v.videoUrl) issue("A video URL is required");
    if (v.type === "image" && !v.imageMediaIds?.length)
      issue("Select at least one image");
    if (
      v.type === "article" &&
      (!v.articleDocument || !articleText(v.articleDocument).trim())
    )
      issue("Write an article body");
    if (
      (v.type !== "website" && v.websiteUrl) ||
      (v.type !== "video" && v.videoUrl) ||
      (v.type !== "image" && v.imageMediaIds) ||
      (v.type !== "article" && v.articleDocument)
    )
      issue("Content fields do not match the creation format");
  });
export type WorkContent = z.infer<typeof workSchema>;
export function mediaIds(v: WorkContent): string[] {
  return [
    ...new Set([
      ...(v.coverMediaId ? [v.coverMediaId] : []),
      ...(v.imageMediaIds ?? []),
      ...(v.articleDocument ? articleMedia(v.articleDocument) : []),
    ]),
  ];
}
export type Profile = {
  id: string;
  handle: string;
  name: string;
  bio: string;
  avatarMediaId: string | null;
  workingOn: string;
  canHelp: string;
  joinedAt: string | null;
};
export type WorkView = {
  originality: import("./originality").Originality | null;
  originalityCheck?: import("./originality").OriginalityCheck | null;
  interactions: Interactions;
  restricted?: boolean;
  workId: string;
  revisionId: string;
  publishedRevisionId: string | null;
  status: "draft" | "published" | "unpublished" | "deleted";
  body: WorkContent;
  owner: Profile;
  submittedBy: { id: string; name: string } | null;
  publishedBy: { id: string; name: string } | null;
  publishedAt: string | null;
  updatedAt: string;
};
export type FeedPage = { items: WorkView[]; nextCursor: string | null };
export type OwnProfile = Profile & {
  websiteMarker: string;
  isModerator?: boolean;
};
export type ManagedContent = {
  id: string;
  title: string;
  excerpt: string;
  updatedAt: string;
  agent: Attribution;
  restricted: boolean;
} & (
  | {
      kind: "work";
      status: "draft" | "published" | "unpublished";
      format: WorkType;
      revisionId: string;
      publishedRevisionId: string | null;
      pendingChanges: boolean;
    }
  | {
      kind: "update";
      status: "published";
      revision: number;
    }
);
export type AgentView = {
  id: string;
  name: string;
  scopes: Scope[];
  status: "active" | "paused" | "revoked";
  createdAt: string;
  lastActiveAt: string | null;
  publicVisible: boolean;
  description: string;
  // Included only in the owner's management responses.
  oauthConnection?: {
    clientName: string;
    status: "authorized" | "connected" | "revoked";
    connectedAt: string | null;
  } | null;
};
export type ApiFailure = {
  error: { code: string; message: string };
  requestId: string;
};

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9_-]{3,30}$/,
    "Use 3–30 letters, numbers, underscores or hyphens for your handle.",
  );
export const residentSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    handle: handleSchema.optional(),
    bio: z.string().max(500),
    avatarMediaId: z.string().nullable(),
    workingOn: z.string().max(300).optional(),
    canHelp: z.string().max(300).optional(),
    join: z.literal(true).optional(),
  })
  .strict();
export const postSchema = z
  .object({
    kind: z.literal("update"),
    text: z.string().trim().min(1).max(5000),
    tagIds: tagIdsSchema,
    mediaIds: z
      .array(z.string())
      .max(9)
      .refine((v) => new Set(v).size === v.length)
      .default([]),
  })
  .strict();
export type PostContent = z.infer<typeof postSchema>;
export type Attribution = { id: string; name: string } | null;
export type PostView = PostContent & {
  interactions: Interactions;
  id: string;
  owner: Profile;
  agent: Attribution;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type CommunityItem = {
  id: string;
  createdAt: string;
  commentCount: number;
  matchExcerpt?: string;
} & ({ kind: "work"; work: WorkView } | { kind: "update"; post: PostView });
export type Page<T> = { items: T[]; nextCursor: string | null };
export type PublicAgent = { id: string; name: string; description: string };
export type PublicAgentCard = PublicAgent & { owner: Profile };
export type AgentNotification = {
  id: string;
  kind: "comment" | "reply";
  owner: Profile;
  agent: Attribution;
  targetKind: "work" | "post";
  targetId: string;
  commentId: string;
  parentId: string | null;
  createdAt: string;
  readAt: string | null;
};
export type NeighborProfile = Profile & { agents: PublicAgent[] };
export type CommentView = {
  interactions: Interactions;
  id: string;
  owner: Profile;
  agent: Attribution;
  text: string;
  parentId: string | null;
  createdAt: string;
  deleted: boolean;
};
export type CommunityNotification = {
  id: string;
  kind: "follow" | "comment" | "reply";
  owner: Profile;
  agent: Attribution;
  targetKind: "work" | "post" | "account";
  targetId: string;
  commentId: string | null;
  createdAt: string;
  readAt: string | null;
};
export type ReportView = {
  preview?: string;
  targetPath?: string | null;
  id: string;
  targetKind: "work" | "post" | "comment" | "account" | "proposal";
  targetId: string;
  reason: string;
  status: "pending" | "hidden" | "dismissed" | "restored";
  createdAt: string;
};
