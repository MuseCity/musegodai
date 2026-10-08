export const siteBuilderIds = ["codex", "claude", "muse"] as const;
export type SiteBuilderId = (typeof siteBuilderIds)[number];

export const siteBuilders = [
  {
    id: "codex",
    name: "Codex / ChatGPT Sites",
    tool: "ChatGPT Sites",
    aliases: ["chatgpt sites", "codex sites"],
    path: "/codex-sites",
    guidePath: "/guides/share-codex-sites",
    title: "Codex Sites gallery",
    description:
      "Discover and share Codex Sites, documented by OpenAI as ChatGPT Sites. Explore websites and small apps shared by their creators.",
    access:
      "Public publishing depends on your account and workspace settings. Check the published link as a visitor before sharing it.",
    guideTitle: "How to share Codex Sites / ChatGPT Sites",
    guideDescription:
      "Publish a ChatGPT Site, check visitor access, and share your Codex Sites project with a cover and build notes on musegod.ai.",
  },
  {
    id: "claude",
    name: "Claude Artifacts",
    tool: "Claude Artifacts",
    aliases: ["claude artifacts"],
    path: "/claude-artifacts",
    guidePath: "/guides/share-claude-artifacts",
    title: "Claude Artifacts gallery",
    description:
      "Discover and share web projects made with Claude Artifacts. Explore creator-submitted interactive pages, tools and experiments.",
    access:
      "Current shared Artifacts require a Claude account. Legacy published Artifacts can have different access rules; describe what your visitors need.",
    guideTitle: "How to share Claude Artifacts",
    guideDescription:
      "Choose an audience for a Claude Artifact, understand current and legacy login requirements, and share your web project on musegod.ai.",
  },
  {
    id: "muse",
    name: "Meta Muse",
    tool: "Meta Muse",
    aliases: ["meta muse", "muse artifacts"],
    path: "/muse-artifacts",
    guidePath: "/guides/share-muse-artifacts",
    title: "Web projects made with Meta Muse",
    description:
      "Discover and share web pages and interactive projects made with Meta Muse. Browse creator-submitted links and learn how to share yours.",
    access:
      "Meta documents web pages and Artifacts, but the sources reviewed here do not establish a general public-hosting workflow. Share a link you can make accessible to visitors.",
    guideTitle: "How to share web projects made with Meta Muse",
    guideDescription:
      "Learn what Meta Muse documents about web pages and Artifacts, check how your project is hosted, and share an accessible link on musegod.ai.",
  },
] satisfies {
  id: SiteBuilderId;
  name: string;
  tool: string;
  aliases: string[];
  path: string;
  guidePath: string;
  title: string;
  description: string;
  access: string;
  guideTitle: string;
  guideDescription: string;
}[];

export type SiteBuilder = (typeof siteBuilders)[number];
export const siteBuilder = (id: string | null) =>
  siteBuilders.find((builder) => builder.id === id);
export const galleryBuilder = (path: string) =>
  siteBuilders.find((builder) => builder.path === path);
export const guideBuilder = (path: string) =>
  siteBuilders.find((builder) => builder.guidePath === path);
export const builderShareHref = (builder: SiteBuilder) =>
  "/publish?from=sites&builder=" + builder.id;
