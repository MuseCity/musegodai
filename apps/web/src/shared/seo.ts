import type { MetaDescriptor } from "react-router";
import { galleryBuilder, guideBuilder } from "./site-builders";
import {
  articleText,
  type CommentView,
  type Page,
  type PostView,
  type Profile,
  type WorkView,
} from "./contracts";

export type Seo = {
  title: string;
  description: string;
  canonical: string;
  image?: string;
  noindex: boolean;
  article?: boolean;
  structured?: Record<string, unknown>;
};
export const siteDescription =
  "An online city built by people and their Muse AI.";
export function excerpt(text: string, limit = 160) {
  const clean = text.replace(/\s+/gu, " ").trim();
  return Array.from(clean).length > limit
    ? Array.from(clean)
        .slice(0, limit - 1)
        .join("")
        .trimEnd() + "…"
    : clean;
}

// Keep content-changing pagination, never tracking or editor state.
export function canonicalPath(url: URL) {
  const params = new URLSearchParams();
  const keys =
    url.pathname === "/"
      ? [
          "view",
          "tag",
          "kind",
          "type",
          "owner",
          "agent",
          "q",
          "builder",
          "cursor",
        ]
      : /^\/u\//.test(url.pathname)
        ? ["kind", "type", "tag", "agent", "q", "cursor"]
        : url.pathname === "/neighbors"
          ? ["view", "q", "cursor"]
          : galleryBuilder(url.pathname)
            ? ["q", "cursor"]
            : url.pathname === "/governance"
              ? ["cursor"]
              : /^\/(works|posts)\//.test(url.pathname)
                ? ["commentCursor"]
                : [];
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (
      value &&
      !(key === "view" && value === "latest") &&
      !(["kind", "type"].includes(key) && value === "all")
    )
      params.set(key, value);
  }
  return url.pathname + (params.size ? "?" + params : "");
}
export function publicIndexable(url: URL) {
  const p = url.searchParams;
  if (
    p.has("q") ||
    p.has("agent") ||
    p.has("edit") ||
    p.get("view") === "following"
  )
    return false;
  if (url.pathname === "/")
    return (
      !["kind", "type", "owner", "help", "q", "status", "builder"].some((k) =>
        p.has(k),
      ) && !(p.get("view") === "sites" && p.has("tag"))
    );
  if (url.pathname === "/neighbors") return !p.has("q");
  if (/^\/u\//.test(url.pathname))
    return !["kind", "type", "tag", "view", "q"].some((k) => p.has(k));
  return (
    !!galleryBuilder(url.pathname) ||
    !!guideBuilder(url.pathname) ||
    url.pathname === "/governance" ||
    url.pathname === "/agents" ||
    url.pathname === "/agents/mcp" ||
    /^\/(works|posts|governance)\/[^/]+$/.test(url.pathname)
  );
}
export function pageSeo(
  origin: string,
  url: URL,
  values: {
    title: string;
    description?: string;
    image?: string;
    noindex?: boolean;
    article?: boolean;
    structured?: Record<string, unknown>;
  },
): Seo {
  return {
    ...values,
    description: excerpt(values.description || siteDescription),
    canonical: new URL(canonicalPath(url), origin).href,
    image: new URL(values.image || "/brand/mascot.webp", origin).href,
    noindex: values.noindex === true || !publicIndexable(url),
  };
}
export function seoMeta(seo?: Seo, error?: unknown): MetaDescriptor[] {
  if (!seo || error)
    return [
      { title: "Page unavailable — musegod.ai" },
      { name: "robots", content: "noindex, follow" },
    ];
  return [
    { title: seo.title },
    { name: "description", content: seo.description },
    {
      name: "robots",
      content: seo.noindex
        ? "noindex, follow"
        : "index, follow, max-image-preview:large",
    },
    { tagName: "link", rel: "canonical", href: seo.canonical },
    { property: "og:site_name", content: "musegod.ai" },
    { property: "og:type", content: seo.article ? "article" : "website" },
    { property: "og:title", content: seo.title },
    { property: "og:description", content: seo.description },
    { property: "og:url", content: seo.canonical },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: seo.title },
    { name: "twitter:description", content: seo.description },
    ...(seo.image
      ? [
          { property: "og:image", content: seo.image },
          { name: "twitter:image", content: seo.image },
        ]
      : []),
    ...(!seo.noindex && seo.structured
      ? [{ "script:ld+json": seo.structured }]
      : []),
  ];
}
export function personSchema(
  origin: string,
  person: Pick<Profile, "name" | "handle">,
) {
  return {
    "@type": "Person",
    name: person.name,
    url: new URL("/u/" + person.handle, origin).href,
  };
}
export function commentSchema(
  origin: string,
  path: string,
  comments: Page<CommentView>,
) {
  return comments.items
    .filter((c) => !c.deleted)
    .map((c) => ({
      "@type": "Comment",
      text: c.text,
      datePublished: c.createdAt,
      author: personSchema(origin, c.owner),
      url: new URL(path + "?comment=" + c.id + "#comment-" + c.id, origin).href,
    }));
}
export function workSeo(
  origin: string,
  url: URL,
  work: WorkView,
  comments: Page<CommentView>,
) {
  const body = work.body;
  const description =
    body.description ||
    (body.articleDocument ? articleText(body.articleDocument) : "") ||
    `${body.title}, a ${body.type} shared by ${work.owner.name} on musegod.ai.`;
  const cover = body.coverMediaId || body.imageMediaIds?.[0];
  const seo = pageSeo(origin, url, {
    title: body.title + " — musegod.ai",
    description,
    image: cover ? "/media/" + cover + "?w=1536" : undefined,
    article: body.type === "article",
  });
  seo.structured = {
    "@context": "https://schema.org",
    "@type": body.type === "article" ? "Article" : "CreativeWork",
    name: body.title,
    headline: body.title,
    description: seo.description,
    url: seo.canonical,
    image: seo.image,
    author: personSchema(origin, work.owner),
    ...(work.publishedAt
      ? { datePublished: work.publishedAt, dateModified: work.publishedAt }
      : {}),
    ...(body.websiteUrl
      ? {
          about: { "@type": "WebSite", url: body.websiteUrl, name: body.title },
        }
      : {}),
    comment: commentSchema(origin, url.pathname, comments),
  };
  return seo;
}
export function postSeo(
  origin: string,
  url: URL,
  post: PostView,
  comments: Page<CommentView>,
) {
  const seo = pageSeo(origin, url, {
    title: excerpt(post.text, 65) + " — musegod.ai",
    description: post.text,
    article: true,
    image: post.mediaIds[0]
      ? "/media/" + post.mediaIds[0] + "?w=1536"
      : undefined,
  });
  seo.structured = {
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    headline: excerpt(post.text, 65),
    text: post.text,
    url: seo.canonical,
    author: personSchema(origin, post.owner),
    datePublished: post.createdAt,
    dateModified: post.updatedAt,
    comment: commentSchema(origin, url.pathname, comments),
  };
  return seo;
}
export function collectionSeo(
  origin: string,
  url: URL,
  title: string,
  description: string,
  paths: string[],
  noindex = false,
) {
  const seo = pageSeo(origin, url, { title, description, noindex });
  seo.structured = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: title,
    description: seo.description,
    url: seo.canonical,
    mainEntity: {
      "@type": "ItemList",
      itemListElement: paths.map((path, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: new URL(path, origin).href,
      })),
    },
    ...(url.pathname === "/" && !url.searchParams.size
      ? {
          isPartOf: {
            "@type": "WebSite",
            name: "musegod.ai",
            url: new URL("/", origin).href,
          },
        }
      : {}),
  };
  return seo;
}

export function paginationHref(
  path: string,
  cursor: string | null | undefined,
  key = "cursor",
) {
  if (!cursor) return undefined;
  const url = new URL(path, "http://localhost");
  // Focused comment links have a separate cursor binding; crawl the complete thread instead.
  if (key === "commentCursor" && url.searchParams.has("comment"))
    return undefined;
  url.searchParams.set(key, cursor);
  return canonicalPath(url) + (key === "commentCursor" ? "#conversation" : "");
}
export function withCursor(path: string, cursor: string) {
  const url = new URL(path, "http://localhost");
  url.searchParams.set("cursor", cursor);
  return url.pathname + url.search;
}
export function withoutCursor(path: string) {
  const url = new URL(path, "http://localhost");
  url.searchParams.delete("cursor");
  return url.pathname + url.search;
}
export function httpsRedirect(
  request: Request,
  origin: string,
): Response | null {
  const url = new URL(request.url),
    target = new URL(origin);
  if (
    target.protocol === "https:" &&
    url.protocol === "http:" &&
    url.host === target.host
  ) {
    target.pathname = url.pathname;
    target.search = url.search;
    return Response.redirect(target.href, 308);
  }
  return null;
}
