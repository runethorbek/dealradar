import { getServerSession } from "next-auth";
import { neon } from "@neondatabase/serverless";
import { authOptions } from "../../../auth.ts";
import { authorizeOwner } from "../../../lib/owner-authorization.mts";
import { parseProductWatchRequest } from "../../../lib/product-watch.mts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorization = authorizeOwner(
    (await getServerSession(authOptions))?.user,
  );

  if (authorization.status === "unauthenticated") {
    return Response.json(
      { success: false, error: "Unauthorized." },
      { status: 401 },
    );
  }

  if (authorization.status === "unauthorized") {
    return Response.json(
      { success: false, error: "Forbidden." },
      { status: 403 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const watchRequest = parseProductWatchRequest(body);

  if (!watchRequest) {
    return Response.json(
      { success: false, error: "Invalid watch request." },
      { status: 400 },
    );
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return Response.json(
      { success: false, error: "Watch state could not be updated." },
      { status: 500 },
    );
  }

  try {
    const sql = neon(databaseUrl);
    const [product] = await sql`
      UPDATE products
      SET watched = ${watchRequest.watched}
      WHERE id = ${watchRequest.productId}
      RETURNING
        id::TEXT AS "productId",
        watched
    `;

    if (!product) {
      return Response.json(
        { success: false, error: "Product not found." },
        { status: 404 },
      );
    }

    return Response.json({
      success: true,
      productId: product.productId,
      watched: product.watched,
    });
  } catch {
    return Response.json(
      { success: false, error: "Watch state could not be updated." },
      { status: 500 },
    );
  }
}
