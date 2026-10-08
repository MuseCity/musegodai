import type {
  OriginalityCheck,
  OriginalityReason,
  OriginalitySubject,
} from "../shared/originality";

export type WebsiteSubject = OriginalitySubject & { marker: string };
export type WebsiteInput = { url: string; subjects: WebsiteSubject[] };
export type WebsiteResult = OriginalityCheck & {
  finalUrl: string | null;
  subject: OriginalitySubject | null;
};
export type WebsiteVerifier = (input: WebsiteInput) => Promise<WebsiteResult>;
export const failedWebsiteCheck = (
  reason: OriginalityReason,
  finalUrl: string | null = null,
): WebsiteResult => ({
  status: "failed",
  reason,
  finalUrl,
  subject: null,
  checkedAt: new Date().toISOString(),
});

export function verificationUrl(value: string, appOrigin: string): URL | null {
  try {
    const url = new URL(value),
      host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !host.includes(".") ||
      host.includes(":") ||
      /^[\d.]+$/.test(host) ||
      /(^|\.)(localhost|local|internal|test|invalid|example|onion|home|lan)$/.test(
        host,
      ) ||
      host === "musegod.ai" ||
      host.endsWith(".musegod.ai") ||
      host === "musecity.xyz" ||
      host.endsWith(".musecity.xyz") ||
      host === new URL(appOrigin).hostname.toLowerCase().replace(/\.$/, "") ||
      !/^[a-z0-9.-]+$/.test(host)
    )
      return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

// Only the Worker runtime performs network checks. Its public-only fetch egress
// is the connection boundary; a DNS preflight followed by a second resolution is not.
export async function verifyWebsite(
  input: WebsiteInput,
  appOrigin: string,
): Promise<WebsiteResult> {
  let url = verificationUrl(input.url, appOrigin);
  if (!url) return failedWebsiteCheck("unsafe_url");
  if (typeof HTMLRewriter === "undefined")
    return failedWebsiteCheck("unavailable");
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await fetch(url.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        cache: "no-store",
        headers: {
          Accept: "text/html",
          "User-Agent": "musegod.ai-Creator-Verification/1.0",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) return failedWebsiteCheck("http_error", url.href);
        const next = verificationUrl(new URL(location, url).href, appOrigin);
        if (!next) return failedWebsiteCheck("unsafe_url", url.href);
        if (next.origin !== url.origin)
          return failedWebsiteCheck("cross_origin_redirect", url.href);
        if (redirects >= 3)
          return failedWebsiteCheck("redirect_limit", url.href);
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return failedWebsiteCheck("http_error", url.href);
      }
      if (
        response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "text/html"
      ) {
        await response.body?.cancel();
        return failedWebsiteCheck("not_html", url.href);
      }
      // Count streamed, decompressed bytes, rather than trusting Content-Length.
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1024 * 1024)
            return failedWebsiteCheck("too_large", url.href);
          chunks.push(chunk.value);
        }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const markers = new Set<string>();
      let headOpen = false;
      let headSeen = false;
      let bodyStarted = false;
      let inertDepth = 0;
      let rawTextDepth = 0;
      const headTags = new Set([
        "html",
        "head",
        "meta",
        "link",
        "base",
        "title",
        "style",
        "script",
        "noscript",
        "template",
      ]);
      const parsed = new HTMLRewriter()
        .on("*", {
          element(element) {
            if (inertDepth) return;
            if (element.tagName === "head") {
              if (!headSeen && !bodyStarted) {
                headSeen = true;
                headOpen = true;
                element.onEndTag(() => {
                  headOpen = false;
                });
              } else headOpen = false;
            } else if (
              (!headOpen && element.tagName !== "html") ||
              (headOpen && !headTags.has(element.tagName))
            ) {
              bodyStarted = true;
              headOpen = false;
            }
          },
        })
        .on("template, svg, math, iframe, noscript", {
          element(element) {
            inertDepth++;
            element.onEndTag(() => {
              inertDepth--;
            });
          },
        })
        .on("title, style, script", {
          element(element) {
            rawTextDepth++;
            element.onEndTag(() => {
              rawTextDepth--;
            });
          },
        })
        .on('head > meta[name="musecity-creator"]', {
          element(element) {
            if (headOpen && inertDepth === 0)
              markers.add(element.getAttribute("content") ?? "");
          },
        })
        .onDocument({
          text(text) {
            // HTMLRewriter streams tokens rather than repairing a browser DOM.
            // Ordinary text starts the body, including an implicitly closed head.
            if (
              !inertDepth &&
              !rawTextDepth &&
              /[^\t\n\f\r ]/.test(text.text)
            ) {
              bodyStarted = true;
              headOpen = false;
            }
          },
        })
        .transform(
          new Response(bytes, {
            headers: { "Content-Type": response.headers.get("content-type")! },
          }),
        );
      await parsed.arrayBuffer();
      if (controller.signal.aborted || Date.now() - startedAt >= 5000)
        return failedWebsiteCheck("timeout", url.href);
      // Subjects arrive in Agent-first order; never infer identity from page content.
      const subject = input.subjects.find((candidate) =>
        markers.has(candidate.marker),
      );
      return subject
        ? {
            status: "verified",
            reason: null,
            checkedAt: new Date().toISOString(),
            finalUrl: url.href,
            subject: { kind: subject.kind, id: subject.id, name: subject.name },
          }
        : failedWebsiteCheck("marker_missing", url.href);
    }
  } catch {
    return failedWebsiteCheck(
      controller.signal.aborted ? "timeout" : "fetch_failed",
      url?.href ?? null,
    );
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
  }
}
