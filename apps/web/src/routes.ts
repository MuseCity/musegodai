import { index, route, type RouteConfig } from "@react-router/dev/routes";
import { siteBuilders } from "./shared/site-builders";
export default [
  index("routes/feed.tsx"),
  ...siteBuilders.flatMap((builder) => [
    route(builder.path.slice(1), "routes/site-gallery.tsx", {
      id: "sites-" + builder.id,
    }),
    route(builder.guidePath.slice(1), "routes/site-guide.tsx", {
      id: "site-guide-" + builder.id,
    }),
  ]),
  route("move-in", "routes/move-in.tsx"),
  route("neighbors", "routes/neighbors.tsx"),
  route("wallet", "routes/wallet.tsx"),
  route("governance", "routes/governance.tsx"),
  route("governance/:id", "routes/proposal.tsx"),
  route("me/home", "routes/home.tsx"),
  route("share", "routes/share.tsx"),
  route("posts/:id", "routes/post.tsx"),
  route("notifications", "routes/notifications.tsx"),
  route("moderation", "routes/moderation.tsx"),
  route("works/:id", "routes/work.tsx"),
  route("u/:handle", "routes/profile.tsx"),
  route("publish", "routes/editor.tsx"),
  route("me/works/:id/edit", "routes/editor.tsx", { id: "edit-work" }),
  route("me/works", "routes/my-works.tsx"),
  route("me/saved", "routes/saved.tsx"),
  route("me/content", "routes/my-content.tsx"),
  route("me/agents", "routes/agents.tsx"),
  route("agents", "routes/agent-onboarding.tsx"),
  route("agents/claim", "routes/claim.tsx"),
  route("agents/connect", "routes/agent-connect.tsx"),
  route("agents/mcp", "routes/mcp-guide.tsx"),
  route("settings", "routes/settings.tsx"),
] satisfies RouteConfig;
