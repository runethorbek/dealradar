import { getServerSession } from "next-auth";
import { neon } from "@neondatabase/serverless";
import { authOptions } from "../../../auth.ts";
import { authorizeOwner } from "../../../lib/owner-authorization.mts";
import { handlePreferencesPost } from "../../../lib/preferences-api.mts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handlePreferencesPost(request, {
    async authorize() {
      const session = await getServerSession(authOptions);
      return authorizeOwner(session?.user);
    },
    async save(profileText) {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");

      const sql = neon(databaseUrl);
      const [preference] = await sql`
        INSERT INTO preferences (id, profile_text)
        VALUES (1, ${profileText})
        ON CONFLICT (id) DO UPDATE SET
          profile_text = EXCLUDED.profile_text,
          updated_at = NOW()
        RETURNING profile_text AS "profileText", updated_at::TEXT AS "updatedAt"
      `;

      if (
        typeof preference?.profileText !== "string" ||
        typeof preference?.updatedAt !== "string"
      ) {
        throw new Error("Preferences query returned an invalid result.");
      }

      return {
        profileText: preference.profileText,
        updatedAt: preference.updatedAt,
      };
    },
  });
}
