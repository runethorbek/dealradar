import { getServerSession } from "next-auth";
import { neon } from "@neondatabase/serverless";
import { authOptions } from "../../../auth.ts";
import { authorizeOwner } from "../../../lib/owner-authorization.mts";
import { handleProductFeedbackPost } from "../../../lib/product-feedback-api.mts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleProductFeedbackPost(request, {
    async authorize() {
      const session = await getServerSession(authOptions);
      return authorizeOwner(session?.user);
    },
    async save({ productId, rating }) {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");

      const sql = neon(databaseUrl);
      const [feedback] = await sql`
      INSERT INTO product_feedback (product_id, rating)
      VALUES (${productId}, ${rating})
      ON CONFLICT (product_id) DO UPDATE SET
        rating = EXCLUDED.rating,
        created_at = NOW()
      RETURNING rating
    `;

      if (feedback?.rating !== "like" && feedback?.rating !== "dislike") {
        throw new Error("Feedback query returned an invalid result.");
      }

      return { rating: feedback.rating };
    },
  });
}
