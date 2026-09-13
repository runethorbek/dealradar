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
    async save(vinted, gemini) {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");
      if (!gemini) {
        const [settings] = await neon(databaseUrl)`
          INSERT INTO application_settings (id, vinted)
          VALUES (1, ${JSON.stringify(vinted)}::JSONB)
          ON CONFLICT (id) DO UPDATE SET vinted = EXCLUDED.vinted, updated_at = NOW()
          RETURNING vinted, updated_at::TEXT AS "updatedAt"
        `;
        if (typeof settings?.updatedAt !== "string") throw new Error("Settings query returned an invalid result.");
        return { vinted, updatedAt: settings.updatedAt };
      }
      const [settings] = await neon(databaseUrl)`
        INSERT INTO application_settings (id, vinted, gemini)
        VALUES (1, ${JSON.stringify(vinted)}::JSONB, ${JSON.stringify(gemini)}::JSONB)
        ON CONFLICT (id) DO UPDATE SET vinted = EXCLUDED.vinted, gemini = EXCLUDED.gemini, updated_at = NOW()
        RETURNING vinted, gemini, updated_at::TEXT AS "updatedAt"
      `;
      if (typeof settings?.updatedAt !== "string") throw new Error("Settings query returned an invalid result.");
      return { vinted, gemini, updatedAt: settings.updatedAt };
    },
  });
}
