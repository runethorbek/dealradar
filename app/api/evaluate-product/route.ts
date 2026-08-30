import { getServerSession } from "next-auth";
import { authOptions } from "../../../auth.ts";
import { authorizeOwner } from "../../../lib/owner-authorization.mts";
import {
  evaluateProduct,
  ProductNotFoundError,
} from "../../../lib/product-evaluation.ts";

export const dynamic = "force-dynamic";

function getProductId(value: unknown) {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  return null;
}

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

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json(
      { success: false, error: "Invalid product ID." },
      { status: 400 },
    );
  }

  const productId = getProductId((body as Record<string, unknown>).productId);

  if (!productId) {
    return Response.json(
      { success: false, error: "Invalid product ID." },
      { status: 400 },
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!databaseUrl || !apiKey) {
    return Response.json(
      { success: false, error: "Product evaluation is not configured." },
      { status: 500 },
    );
  }

  try {
    const evaluation = await evaluateProduct({
      productId,
      databaseUrl,
      apiKey,
    });

    return Response.json({ success: true, evaluation });
  } catch (error) {
    if (error instanceof ProductNotFoundError) {
      return Response.json(
        { success: false, error: "Product not found." },
        { status: 404 },
      );
    }

    return Response.json(
      { success: false, error: "Product evaluation failed." },
      { status: 500 },
    );
  }
}
