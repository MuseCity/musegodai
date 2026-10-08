import { siteSharingGuides } from "../shared/site-sharing-guides";
import {
  Link,
  useLoaderData,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { servicesContext } from "../context";
import { pageSeo, seoMeta } from "../shared/seo";
import { builderShareHref, guideBuilder } from "../shared/site-builders";
import { SiteBuilderLinks } from "../components/site-builder-links";
import { useContentSource } from "../components/content-navigation";

export function loader({ url, context }: LoaderFunctionArgs) {
  const builder = guideBuilder(url.pathname);
  if (!builder) throw new Response("Not found", { status: 404 });
  const { origin } = context.get(servicesContext);
  const guidance = siteSharingGuides[builder.id];
  return {
    builder,
    guidance,
    seo: pageSeo(origin, url, {
      title: builder.guideTitle + " — musegod.ai",
      description: builder.guideDescription,
      article: true,
      structured: {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: builder.guideTitle,
        description: builder.guideDescription,
        url: new URL(builder.guidePath, origin).href,
        dateModified: "2026-09-28",
        author: { "@type": "Organization", name: "musegod.ai", url: origin },
        citation: guidance.sources.map((source) => source.url),
      },
    }),
  };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData, error }) =>
  seoMeta(loaderData?.seo, error);
export default function SiteGuide() {
  const { builder, guidance } = useLoaderData<typeof loader>();
  const state = useContentSource();
  return (
    <div className="mx-auto max-w-3xl py-6">
      <SiteBuilderLinks />
      <article className="prose">
        <p className="eyebrow">Sharing guide · Reviewed September 28, 2026</p>
        <h1>{builder.guideTitle}</h1>
        <p>{guidance.intro}</p>
        {guidance.sections.map((section, i) => (
          <section key={section.title}>
            <h2>
              {i + 1}. {section.title}
            </h2>
            <p>{section.text}</p>
          </section>
        ))}
        <h2>4. Share your project on musegod.ai</h2>
        <ol>
          <li>
            Sign in and{" "}
            <Link state={state} to={builderShareHref(builder)}>
              share your project
            </Link>
            . This opens a Website submission with AI-assisted selected and{" "}
            <strong>{builder.tool}</strong> in Made with. Review and correct
            these declarations to match your work.
          </li>
          <li>
            Add the HTTPS website link, a title and a cover showing your
            project. Describe what it does, who can use it, and any sign-in
            requirements. A useful build note helps others learn from your work.
          </li>
          <li>
            Choose relevant topics, preview your submission, then publish when
            it is ready. Your work appears in Sites and its builder gallery when
            the published tool declaration matches. Draft edits stay private
            until you publish again.
          </li>
        </ol>
        <p>
          musegod.ai shares a link to your project and hosts its community
          discussion. It does not host the external app, change its audience, or
          grant visitors access to a private workspace. Removing a listing from
          musegod.ai does not unpublish the original project.
        </p>
        <h2>Explore community projects</h2>
        <p>
          <Link to={builder.path}>Browse {builder.name} projects →</Link> Read
          what creators built, try their public links, and leave useful
          feedback. Listings and tool choices are supplied by their authors;
          they are not official provider endorsements.
        </p>
        <h2>Official documentation</h2>
        <p>
          Provider controls can change. These sources were reviewed on September
          28, 2026; use the current documentation and your account's actual
          sharing options.
        </p>
        <ul>
          {guidance.sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.label}
              </a>
            </li>
          ))}
        </ul>
      </article>
    </div>
  );
}
