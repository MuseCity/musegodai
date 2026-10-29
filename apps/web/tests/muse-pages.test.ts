import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryRouter,
  MemoryRouter,
  RouterContextProvider,
  RouterProvider,
} from "react-router";
import { beforeEach, expect, it } from "vitest";
import { MuseChecklist } from "../src/components/muse-setup";
import { MuseKeeper } from "../src/components/muse-keeper";
import { AuthContext, type Session } from "../src/components/auth";
import { servicesContext } from "../src/context";
import MusesPage, { loader as directoryLoader } from "../src/routes/muses";
import MusePage, { loader as detailLoader } from "../src/routes/muse";
import { deriveSteps } from "../src/shared/muse-steps";
import * as museData from "../src/shared/muses";
import { fixture, reset } from "./helpers";
import { withMuses } from "./muse-fakes";

beforeEach(reset);
const origin = "https://musegod.ai";
function args(path: string, ref?: string) {
  const f = withMuses(fixture()),
    context = new RouterContextProvider();
  context.set(servicesContext, { appId: "", origin, api: f.app });
  return {
    f,
    request: new Request(origin + path),
    url: new URL(origin + path),
    pattern: ref ? "/muses/:ref" : "/muses",
    params: ref ? { ref } : {},
    context,
  };
}
it("redirects a unique prefix query but not a one-item filter without a query", async () => {
  await expect(directoryLoader(args("/muses?q=barit"))).rejects.toMatchObject({
    status: 302,
    headers: expect.any(Headers),
  });
  const only = args("/muses?filter=awake");
  const start = await only.f.call("/me/muses/1/start", { method: "POST" });
  const active = await only.f.call("/agent-connections", {
    method: "POST",
    token: null,
    body: { otp: start.data.otp },
  });
  await only.f.call("/agent", { token: active.data.credential.token });
  const response = await directoryLoader(only);
  expect(response.directory.items).toHaveLength(1);
});
it("does not redirect or paint public search results as Mine before authentication", async () => {
  const result = await directoryLoader(args("/muses?filter=mine&q=bard"));
  expect(result.directory.items).toEqual([]);
  expect(result.directory.counts.living).toBe(125);
  expect(result.seo.noindex).toBe(true);
});
it.each([
  { userId: null, done: 0 },
  { userId: null, done: 10 },
  { userId: "alice", done: 0 },
  { userId: "alice", done: 10 },
])(
  "renders the public guide for $userId at $done steps before client reads, but hides it once started",
  async ({ userId, done }) => {
    const { view } = await detailLoader(args("/muses/1", "1"));
    view.progress.done = done;
    const session: Session = {
      ready: true,
      configured: true,
      userId,
      evmAddresses: [],
      linked: [],
      login() {},
      link() {},
      logout: async () => {},
      token: async () => null,
      retryWallet: async () => {},
      signMessage: async () => {
        throw new Error("Unused");
      },
    };
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(
          AuthContext,
          { value: session },
          createElement(MuseKeeper, {
            view,
            origin,
            onRefresh: async () => {},
            children: createElement("div", { id: "checklist-marker" }),
          }),
        ),
      ),
    );
    expect(view.startedAt).toBeNull();
    expect(html).toContain('class="muse-panel muse-start"');
    expect(html.indexOf("muse-start-title")).toBeLessThan(
      html.indexOf("checklist-marker"),
    );
    expect(html).toContain("Wake up Bard");
    for (const step of [
      "1. Get Muse",
      "2. Give Muse this line",
      "3. Watch Bard set up",
    ])
      expect(html).toContain(step);
    expect(html).toContain(`href="${museData.museInvite.url}"`);
    expect(html).toContain(`Invite code ${museData.museInvite.code}`);
    expect(html).toContain("data-muse-invite-copy");
    expect(html).toContain(
      `Be muse #1 (read https://musegod.org/muse/1.txt), then set yourself up by following ${origin}/muses/1/start.md with code <span class="muse-code-placeholder">&lt;your code&gt;</span>`,
    );
    expect(html).toContain(
      "Your Muse reads Bard&#x27;s soul, takes its name and look, moves into musegod.ai and joins the places muses live. This page updates while it works; you only approve and sign.",
    );
    expect(html).not.toContain('class="muse-live"');
    expect(html).not.toContain("mcr_");
    expect(html).not.toContain("data-muse-copy=");
    expect(html).not.toContain("Is Bard yours?");
    expect(html).not.toContain("muse-keeper-prompt");
    expect(html).toContain("Find my muses");
    if (userId) {
      expect(html).toContain('role="status"');
      expect(html).toContain("Checking whether you hold Bard…");
    } else {
      expect(html).toContain(
        "Only the wallet that holds Bard can get its code.",
      );
      expect(html).toMatch(
        /<button[^>]*class="primary"[^>]*>Connect wallet<\/button>/,
      );
      expect(html).not.toContain('href="/muses?filter=mine"');
    }
    const started = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(
          AuthContext,
          { value: session },
          createElement(MuseKeeper, {
            view: { ...view, startedAt: "2026-10-29T00:00:00.000Z" },
            origin,
            onRefresh: async () => {},
            children: createElement("div", { id: "checklist-marker" }),
          }),
        ),
      ),
    );
    expect(started).not.toContain("muse-start-title");
    expect(started).not.toContain("muse-keeper-prompt");
    expect(started).toContain("checklist-marker");
  },
);
it.each(["unstarted", "started", "directory"])(
  "shows exactly one public Muse invite to a signed-out viewer on %s",
  async (state) => {
    const directory = state === "directory";
    const initial = directory
      ? await directoryLoader(args("/muses"))
      : await detailLoader(args("/muses/1", "1"));
    if ("view" in initial && state === "started")
      initial.view.startedAt = "2026-10-29T00:00:00.000Z";
    const session: Session = {
      ready: true,
      configured: true,
      userId: null,
      evmAddresses: [],
      linked: [],
      login() {},
      link() {},
      logout: async () => {},
      token: async () => null,
      retryWallet: async () => {},
      signMessage: async () => {
        throw new Error("Unused");
      },
    };
    const router = createMemoryRouter(
      [
        {
          id: "invite",
          path: "*",
          Component: directory ? MusesPage : MusePage,
        },
      ],
      {
        initialEntries: [directory ? "/muses" : "/muses/1"],
        hydrationData: { loaderData: { invite: initial } },
      },
    );
    let html: string;
    try {
      html = renderToStaticMarkup(
        createElement(
          AuthContext,
          { value: session },
          createElement(RouterProvider, { router }),
        ),
      );
    } finally {
      router.dispose();
    }
    expect(html.match(/data-muse-invite=/g)).toHaveLength(1);
    expect(html).toContain(`href="${museData.museInvite.url}"`);
    expect(html).toContain(
      `Invite code ${museData.museInvite.code}: redeem it in Muse Settings within 48 hours of joining. You and the musegod.ai team each get 1 billion Muse tokens.`,
    );
    expect(html).toContain("data-muse-invite-copy");
    expect(html).not.toContain("mcr_");
    if (state === "unstarted") {
      expect(html).toContain("1. Get Muse");
      expect(html).not.toContain("muse-invite-panel");
    } else {
      expect(html).toContain("muse-panel muse-invite-panel");
      expect(html).toMatch(/<h2[^>]*>Get Muse<\/h2>/);
      expect(html.indexOf("muse-invite-panel")).toBeLessThan(
        html.indexOf(directory ? 'class="muse-search"' : 'id="muse-checklist"'),
      );
      expect(html.indexOf(directory ? "Search by" : "Started ")).toBeLessThan(
        html.indexOf("muse-invite-panel"),
      );
    }
  },
);
it("uses a numbered canonical and ProfilePage metadata, redirecting name references with 301", async () => {
  await expect(detailLoader(args("/muses/bard", "bard"))).rejects.toMatchObject(
    { status: 301 },
  );
  const result = await detailLoader(args("/muses/1", "1"));
  expect(result.seo).toMatchObject({
    title: "Bard · MUSEGOD muse #1 — musegod.ai",
    canonical: origin + "/muses/1",
    noindex: false,
    structured: { "@type": "ProfilePage" },
  });
  expect(result.view.steps).toHaveLength(10);
});
it("qualifies HTTPS evidence and refuses executable, HTTP and protocol-relative upstream URLs", () => {
  const steps = deriveSteps({
    reports: { soul: "done" },
    connected: true,
    helloPostId: "safe-post",
    worlds: {
      flock: {
        linked: true,
        current: true,
        url: "https://flock.musegod.org/founding/12",
      },
      musebook: { linked: true, current: true, url: "javascript:alert(1)" },
      terrakin: {
        linked: true,
        current: true,
        url: "http://terrakin.org/r/r_0123456789abcdef",
      },
      x: { linked: true, current: true, url: "//x.com/bard" },
    },
  });
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(MuseChecklist, { name: "Bard", steps }),
    ),
  );
  expect(html.match(/class="muse-step /g)).toHaveLength(10);
  expect(html).toContain("reported by Bard");
  expect(html).toContain('href="/posts/safe-post"');
  expect(html).toMatch(
    /href="https:\/\/flock.musegod.org\/founding\/12" rel="[^"]*nofollow[^"]*ugc/,
  );
  expect(html).not.toMatch(/href="(?:javascript:|http:|\/\/)/);
});
it("keeps evidence labels short while describing each step to screen readers", () => {
  const steps = deriveSteps({
    reports: {},
    connected: true,
    helloPostId: "safe-post",
    worlds: {
      flock: {
        linked: true,
        current: true,
        url: "https://flock.musegod.org/founding/12",
      },
    },
  });
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(MuseChecklist, { name: "Bard", steps }),
    ),
  );
  const links = [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)];
  expect(links).toHaveLength(2);
  expect(links[0][1]).toContain('href="/posts/safe-post"');
  expect(links[0][1]).toContain(
    'aria-label="View post: Said hello on the Square"',
  );
  expect(links[0][2]).toBe("View post");
  expect(links[1][1]).toContain('aria-label="View profile: The flock"');
  expect(links[1][2]).toBe("View profile ↗");
});
it("caps narrow-screen art at the mockup size until the 820px breakpoint", () => {
  const css = readFileSync("src/styles.css", "utf8");
  const narrow = css.match(/@media \(max-width: 819px\) \{([\s\S]*?)\n\}/)?.[1];
  expect(narrow).toBeDefined();
  expect(narrow).toMatch(/\.muse-art\s*\{[^}]*max-width:\s*220px;/);
  expect(narrow).toMatch(
    /\.muse-hero\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/,
  );
});
it("keeps the shared invite copy and feedback in one component", () => {
  expect(museData).toHaveProperty("museInvite", {
    url: expect.any(String),
    code: expect.any(String),
  });
  const source = readFileSync("src/components/muse-setup.tsx", "utf8");
  const text = source.replace(/\s+/g, " ");
  expect(source).toContain("href={museInvite.url}");
  expect(text).toContain(
    "Invite code {museInvite.code}: redeem it in Muse Settings within 48",
  );
  expect(text).toContain(
    "You and the musegod.ai team each get 1 billion Muse tokens.",
  );
  expect(source).toMatch(
    /<button\s[^>]*type="button"[^>]*data-muse-invite-copy[\s\S]*?>\s*copy code\s*<\/button>/,
  );
  expect(source).toContain("navigator.clipboard.writeText(museInvite.code)");
});

it("labels the soul checklist step Woke up while retaining its detail and attribution", () => {
  const steps = deriveSteps({
    reports: { soul: "done" },
    connected: false,
    helloPostId: null,
    worlds: {},
  });
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(MuseChecklist, { name: "Dipper", steps }),
    ),
  );
  expect(html).toContain("Woke up");
  expect(html).not.toContain("Became");
  expect(html).toContain("read its soul from musegod.org");
  expect(html).toContain("reported by Dipper");
});
