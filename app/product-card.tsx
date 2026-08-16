"use client";

/* eslint-disable @next/next/no-img-element */

import { useState } from "react";

export type Rating = "like" | "dislike";

export type ProductCardProduct = {
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
  feedback: Rating | null;
};

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

export function ProductCard({ product }: { product: ProductCardProduct }) {
  const [feedback, setFeedback] = useState<Rating | null>(product.feedback);
  const [saving, setSaving] = useState<Rating | null>(null);
  const [failed, setFailed] = useState(false);

  async function saveFeedback(rating: Rating) {
    setSaving(rating);
    setFailed(false);

    try {
      const response = await fetch("/api/product-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.id, rating }),
      });
      const result = (await response.json()) as { rating?: unknown };

      if (
        !response.ok ||
        (result.rating !== "like" && result.rating !== "dislike")
      ) {
        throw new Error("Feedback request failed.");
      }

      setFeedback(result.rating);
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
    }
  }

  return (
    <article className="group overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md">
      <a
        href={product.externalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block"
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

        <div className="p-5 pb-4">
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

      <div className="flex items-center gap-2 border-t border-zinc-100 px-5 py-3">
        <span className="mr-auto text-xs text-zinc-400">Was this useful?</span>
        {(["like", "dislike"] as const).map((rating) => {
          const isActive = feedback === rating;
          const isLike = rating === "like";

          return (
            <button
              key={rating}
              type="button"
              aria-label={isLike ? "Like product" : "Dislike product"}
              aria-pressed={isActive}
              disabled={saving !== null}
              onClick={() => saveFeedback(rating)}
              className={`rounded-md border px-2.5 py-1.5 text-sm transition disabled:cursor-wait disabled:opacity-60 ${
                isActive
                  ? isLike
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-rose-200 bg-rose-50"
                  : "border-zinc-200 bg-white hover:bg-zinc-50"
              }`}
            >
              <span aria-hidden>{isLike ? "👍" : "👎"}</span>
            </button>
          );
        })}
      </div>
      {failed ? (
        <p className="px-5 pb-3 text-right text-xs text-rose-600" role="status">
          Could not save feedback.
        </p>
      ) : null}
    </article>
  );
}
