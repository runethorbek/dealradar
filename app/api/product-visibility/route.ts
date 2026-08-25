import { neon } from "@neondatabase/serverless";
import { parseProductVisibilityRequest } from "@/lib/product-visibility.mts";

export const dynamic = "force-dynamic";

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

  const visibilityRequest = parseProductVisibilityRequest(body);

  if (!visibilityRequest) {
    return Response.json(
      { success: false, error: "Invalid visibility request." },
      { status: 400 },
    );
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return Response.json(
      { success: false, error: "Visibility could not be updated." },
      { status: 500 },
    );
  }

  try {
    const sql = neon(databaseUrl);
    const [product] = await sql`
      UPDATE products
      SET hidden = ${visibilityRequest.hidden}
      WHERE id = ${visibilityRequest.productId}
      RETURNING
        id::TEXT AS "productId",
        hidden
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
      hidden: product.hidden,
    });
  } catch {
    return Response.json(
      { success: false, error: "Visibility could not be updated." },
      { status: 500 },
    );
  }
}
