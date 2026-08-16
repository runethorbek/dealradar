/* eslint-disable @next/next/no-img-element */

import { neon } from "@neondatabase/serverless";
import Link from "next/link";
import { connection } from "next/server";

type Source = "vinted.com" | "zalando.dk" | "scarosso.com";

const sourceFilters: { label: string; value: Source | null }[] = [
  { label: "All", value: null },
  { label: "Vinted", value: "vinted.com" },
  { label: "Zalando", value: "zalando.dk" },
  { label: "Scarosso", value: "scarosso.com" },
];

type Product = {
  id: string;
  externalUrl: string;
  title: string;
  imageUrl: string | null;
  source: string;
  currentPrice: string | null;
  originalPrice: string | null;
  currency: string | null;
  discountPercent: string | null;
  lastSeenAt: string;
};

async function getLatestProducts(source: Source | null) {
  await connection();

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return { products: [] as Product[], failed: true };
  }

  try {
    const sql = neon(databaseUrl);
    const rows = source
      ? await sql`
          SELECT
            id::TEXT AS id,
            external_url AS "externalUrl",
            title,
            image_url AS "imageUrl",
            source,
            current_price::TEXT AS "currentPrice",
            original_price::TEXT AS "originalPrice",
            currency,
            discount_percent::TEXT AS "discountPercent",
            last_seen_at::TEXT AS "lastSeenAt"
          FROM products
          WHERE source = ${source}
          ORDER BY last_seen_at DESC
          LIMIT 50
        `
      : await sql`
          SELECT
            id::TEXT AS id,
            external_url AS "externalUrl",
            title,
            image_url AS "imageUrl",
            source,
            current_price::TEXT AS "currentPrice",
            original_price::TEXT AS "originalPrice",
            currency,
            discount_percent::TEXT AS "discountPercent",
            last_seen_at::TEXT AS "lastSeenAt"
          FROM products
          ORDER BY last_seen_at DESC
          LIMIT 50
        `;

    return { products: rows as Product[], failed: false };
  } catch {
    return { products: [] as Product[], failed: true };
  }
}

function formatPrice(value: string | null, currency: string | null) {
  if (value === null) {
    return "Price unavailable";
  }

  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return value;
  }

  if (currency) {
    try {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).format(amount);
    } catch {
      // Fall through when a source provides a non-standard currency code.
    }
  }

  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatLastSeen(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
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
              <a
                key={product.id}
                href={product.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md"
              >
                <div className="aspect-[4/3] overflow-hidden bg-zinc-100">
                  {product.imageUrl ? (
                    <img
                      src={product.imageUrl}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-zinc-400">
                      No image
                    </div>
                  )}
                </div>

                <div className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                      {product.source}
                    </p>
                    {product.discountPercent !== null ? (
                      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                        -{Number(product.discountPercent).toLocaleString("en", {
                          maximumFractionDigits: 1,
                        })}
                        %
                      </span>
                    ) : null}
                  </div>

                  <h3 className="mt-2 line-clamp-2 min-h-12 text-base font-semibold leading-6 tracking-tight group-hover:text-zinc-600">
                    {product.title}
                  </h3>

                  <div className="mt-4 flex items-baseline gap-2">
                    <p className="font-semibold">
                      {formatPrice(product.currentPrice, product.currency)}
                    </p>
                    {product.originalPrice !== null ? (
                      <p className="text-sm text-zinc-400 line-through">
                        {formatPrice(product.originalPrice, product.currency)}
                      </p>
                    ) : null}
                  </div>

                  <p className="mt-4 border-t border-zinc-100 pt-4 text-xs text-zinc-400">
                    Last seen {formatLastSeen(product.lastSeenAt)} UTC
                  </p>
                </div>
              </a>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
