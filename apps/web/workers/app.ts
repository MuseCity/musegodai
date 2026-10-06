import { servicesContext } from "../src/context";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { createApi, productionServices } from "../src/server/api";
import { httpsRedirect } from "../src/shared/seo";
const handler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);
export default {
  async fetch(request, env, ctx) {
    const redirect = httpsRedirect(request, env.APP_ORIGIN);
    if (redirect) return redirect;
    const api = createApi(productionServices(env, ctx));
    const path = new URL(request.url).pathname;
    if (
      path.startsWith("/api/") ||
      path.startsWith("/oauth/") ||
      path.startsWith("/.well-known/") ||
      path.startsWith("/media/") ||
      path.startsWith("/sitemaps/") ||
      [
        "/skill.md",
        "/openapi.json",
        "/mcp",
        "/robots.txt",
        "/sitemap.xml",
      ].includes(path)
    )
      return api.fetch(request);
    const context = new RouterContextProvider();
    context.set(servicesContext, {
      appId: env.PRIVY_APP_ID,
      origin: env.APP_ORIGIN,
      api,
    });
    const response = await handler(request, context);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set(
      "Referrer-Policy",
      path === "/agents/connect"
        ? "no-referrer"
        : "strict-origin-when-cross-origin",
    );
    if (path === "/agents/connect") {
      response.headers.set("X-Frame-Options", "DENY");
      response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
