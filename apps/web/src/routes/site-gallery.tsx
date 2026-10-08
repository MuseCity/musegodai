import {
  Link,
  useLoaderData,
  useLocation,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { servicesContext } from "../context";
import { publicRead } from "../route-data";
import type { CommunityItem, Page } from "../shared/contracts";
import { collectionSeo, seoMeta } from "../shared/seo";
import { builderShareHref, galleryBuilder } from "../shared/site-builders";
import {
  CommunityCard,
  LoadMore,
  QueryState,
  useNeighborhoodPage,
} from "../components/neighborhood";
import { useContentSource } from "../components/content-navigation";
import { SiteBuilderLinks } from "../components/site-builder-links";
import { ContentSearch } from "../components/content-search";
import { Empty } from "../components/ui";

export async function loader(args: LoaderFunctionArgs) {
  const { url, context } = args;
  const builder = galleryBuilder(url.pathname);
  if (!builder) throw new Response("Not found", { status: 404 });
  if (
    ["builder", "view", "kind", "type", "tag", "owner", "help", "status"].some(
      (key) => url.searchParams.has(key),
    )
  )
    throw new Response("Use the builder gallery without secondary filters", {
      status: 400,
    });
  const params = new URLSearchParams({ view: "sites", builder: builder.id });
  if (url.searchParams.has("cursor"))
    params.set("cursor", url.searchParams.get("cursor")!);
  if (url.searchParams.has("q")) params.set("q", url.searchParams.get("q")!);
  const feedPath = "/feed?" + params;
  const page = await publicRead<Page<CommunityItem>>(args, feedPath);
  const { origin } = context.get(servicesContext);
  return {
    builder,
    feedPath,
    page,
    seo: collectionSeo(
      origin,
      url,
      builder.title + " — musegod.ai",
      builder.description,
      page.items.map((item) => "/works/" + item.id),
      !page.items.length,
    ),
  };
}
export const meta: MetaFunction<typeof loader> = ({ loaderData, error }) =>
  seoMeta(loaderData?.seo, error);
export default function SiteGallery() {
  const location = useLocation();
  return <Gallery key={location.key} />;
}
function Gallery() {
  const { builder, feedPath, page } = useLoaderData<typeof loader>();
  const query = useNeighborhoodPage<CommunityItem>(feedPath, page);
  const state = useContentSource();
  const location = useLocation();
  return (
    <section className="mx-auto max-w-3xl py-6">
      <SiteBuilderLinks />
      <header className="mb-6">
        <p className="eyebrow">Community websites</p>
        <h1>{builder.title}</h1>
        <p className="mt-3">{builder.description}</p>
        <p className="text-muted text-sm mt-3">{builder.access}</p>
        <div className="flex flex-wrap gap-4 items-center mt-5">
          <Link
            className="primary"
            state={state}
            to={builderShareHref(builder)}
          >
            Share your project
          </Link>
          <Link className="text-link" to={builder.guidePath}>
            Read the sharing guide →
          </Link>
        </div>
      </header>
      <p className="text-muted text-sm mb-3">
        Sources are declared by creators. musegod.ai is an independent
        community; listings are not verified by the builder.
      </p>
      <ContentSearch placeholder={"Search " + builder.name + " websites…"} />
      <QueryState busy={query.busy} error={query.error} retry={query.reload} />
      {!query.busy &&
        !query.error &&
        (query.data?.items.length ? (
          <div className="community-stream">
            {query.data.items.map((item) => (
              <CommunityCard key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <Empty
            title={
              new URLSearchParams(location.search).get("q")
                ? "No matching websites here."
                : "Be the first to share a project here."
            }
          >
            <p>
              {new URLSearchParams(location.search).get("q")
                ? "Try another search or clear it to browse this gallery."
                : "Add a working link, a cover and a few words about what you built with " +
                  builder.name +
                  "."}
            </p>
          </Empty>
        ))}
      <LoadMore
        next={query.data?.nextCursor}
        busy={query.moreBusy}
        error={query.moreError}
        onClick={() => void query.more()}
        publicPath={location.pathname + location.search}
      />
    </section>
  );
}
