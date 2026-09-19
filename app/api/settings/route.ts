import { neon } from "@neondatabase/serverless";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { authorizeOwner } from "@/lib/owner-authorization.mts";
import { handleSettingsPost } from "@/lib/settings-api.mts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleSettingsPost(request, {
    async authorize() {
      return authorizeOwner((await getServerSession(authOptions))?.user);
    },
    async save(vinted, gemini, brandFilter, ranking) {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");
      const [settings] = await neon(databaseUrl)`
        INSERT INTO application_settings (id, vinted, gemini, brand_filter, ranking)
        VALUES (
          1,
          ${JSON.stringify(vinted)}::JSONB,
          COALESCE(${gemini ? JSON.stringify(gemini) : null}::JSONB, (SELECT gemini FROM application_settings WHERE id = 1)),
          COALESCE(${brandFilter ? JSON.stringify(brandFilter) : null}::JSONB, (SELECT brand_filter FROM application_settings WHERE id = 1)),
          COALESCE(${ranking ? JSON.stringify(ranking) : null}::JSONB, (SELECT ranking FROM application_settings WHERE id = 1))
        )
        ON CONFLICT (id) DO UPDATE SET
          vinted = EXCLUDED.vinted,
          gemini = EXCLUDED.gemini,
          brand_filter = EXCLUDED.brand_filter,
          ranking = EXCLUDED.ranking,
          updated_at = NOW()
        RETURNING vinted, gemini, brand_filter AS "brandFilter", ranking, updated_at::TEXT AS "updatedAt"
      `;
      if (typeof settings?.updatedAt !== "string") throw new Error("Settings query returned an invalid result.");
      return { vinted, gemini: settings.gemini, brandFilter: settings.brandFilter, ranking: settings.ranking, updatedAt: settings.updatedAt };
    },
  });
}
