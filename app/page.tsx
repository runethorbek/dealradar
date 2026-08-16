import { neon } from "@neondatabase/serverless";
import Link from "next/link";
import { connection } from "next/server";
import { ProductCard, type ProductCardProduct } from "./product-card";

type Source = "vinted.com" | "zalando.dk" | "scarosso.com";

const sourceFilters: { label: string; value: Source | null }[] = [
  { label: "All", value: null },
  { label: "Vinted", value: "vinted.com" },
  { label: "Zalando", value: "zalando.dk" },
  { label: "Scarosso", value: "scarosso.com" },
];

async function getLatestProducts(source: Source | null) {
  await connection();

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return { products: [] as ProductCardProduct[], failed: true };
  }

  try {
    const sql = neon(databaseUrl);
    const rows = source
      ? await sql`
          SELECT
            p.id::TEXT AS id,
            p.external_url AS "externalUrl",
            p.title,
            p.image_url AS "imageUrl",
            p.source,
            p.current_price::TEXT AS "currentPrice",
            p.original_price::TEXT AS "originalPrice",
            p.currency,
            p.discount_percent::TEXT AS "discountPercent",
            p.last_seen_at::TEXT AS "lastSeenAt",
            pf.rating AS feedback
          FROM products p
          LEFT JOIN product_feedback pf ON pf.product_id = p.id
          WHERE p.source = ${source}
          ORDER BY p.last_seen_at DESC
          LIMIT 50
        `
      : await sql`
          SELECT
            p.id::TEXT AS id,
            p.external_url AS "externalUrl",
            p.title,
            p.image_url AS "imageUrl",
            p.source,
            p.current_price::TEXT AS "currentPrice",
            p.original_price::TEXT AS "originalPrice",
            p.currency,
            p.discount_percent::TEXT AS "discountPercent",
            p.last_seen_at::TEXT AS "lastSeenAt",
            pf.rating AS feedback
          FROM products p
          LEFT JOIN product_feedback pf ON pf.product_id = p.id
          ORDER BY p.last_seen_at DESC
          LIMIT 50
        `;

    return { products: rows as ProductCardProduct[], failed: false };
  } catch {
    return { products: [] as ProductCardProduct[], failed: true };
  }
}

export default async function Home({ searchParams }: PageProps<"/">) {
  const requestedSource = (await searchParams).source;
  const selectedSource = sourceFilters.some(
    (filter) => filter.value === requestedSource,
  )
    ? (requestedSource as Source)
    : null;
  const { products, failed } = await getLatestProducts(selectedSource);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-6 lg:px-8">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-950 text-sm font-semibold text-white">
            D
          </span>
          <h1 className="ml-3 text-lg font-semibold tracking-tight">DealRadar</h1>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-zinc-500">Dashboard</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">
              Latest deals
            </h2>
          </div>
          {!failed && products.length > 0 ? (
            <p className="text-sm text-zinc-500">
              {products.length} {products.length === 1 ? "product" : "products"}
            </p>
          ) : null}
        </div>

        <nav aria-label="Filter deals by source" className="mb-6 flex flex-wrap gap-2">
          {sourceFilters.map((filter) => {
            const isActive = filter.value === selectedSource;

            return (
              <Link
                key={filter.label}
                href={filter.value ? `/?source=${filter.value}` : "/"}
                aria-current={isActive ? "page" : undefined}
                className={`rounded-full border px-4 py-2 text-sm font-medium transition ${
                  isActive
                    ? "border-zinc-950 bg-zinc-950 text-white"
                    : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-950"
                }`}
              >
                {filter.label}
              </Link>
            );
          })}
        </nav>

        {failed ? (
          <div className="rounded-xl border border-zinc-200 bg-white px-6 py-12 text-center shadow-sm">
            <p className="text-sm text-zinc-500">
              Deals could not be loaded right now.
            </p>
          </div>
        ) : products.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-12 text-center">
            <p className="text-sm text-zinc-500">
              No products have been imported yet.
            </p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
