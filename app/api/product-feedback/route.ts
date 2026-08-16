import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

type Rating = "like" | "dislike";

function getProductId(value: unknown) {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  return null;
}

function getRating(value: unknown): Rating | null {
  return value === "like" || value === "dislike" ? value : null;
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json(
      { success: false, error: "Invalid feedback." },
      { status: 400 },
    );
  }

  const productId = getProductId((body as Record<string, unknown>).productId);
  const rating = getRating((body as Record<string, unknown>).rating);

  if (!productId || !rating) {
    return Response.json(
      { success: false, error: "Invalid feedback." },
      { status: 400 },
    );
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return Response.json(
      { success: false, error: "Feedback could not be saved." },
      { status: 500 },
    );
  }

  try {
    const sql = neon(databaseUrl);
    const [feedback] = await sql`
      INSERT INTO product_feedback (product_id, rating)
      VALUES (${productId}, ${rating})
      ON CONFLICT (product_id) DO UPDATE SET
        rating = EXCLUDED.rating,
        created_at = NOW()
      RETURNING rating
    `;

    return Response.json({ success: true, rating: feedback.rating });
  } catch {
    return Response.json(
      { success: false, error: "Feedback could not be saved." },
      { status: 500 },
    );
  }
}
