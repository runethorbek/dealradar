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
    async save(vinted) {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error("DATABASE_URL is not configured.");
      const [settings] = await neon(databaseUrl)`
        INSERT INTO application_settings (id, vinted)
        VALUES (1, ${JSON.stringify(vinted)}::JSONB)
        ON CONFLICT (id) DO UPDATE SET vinted = EXCLUDED.vinted, updated_at = NOW()
        RETURNING vinted, updated_at::TEXT AS "updatedAt"
      `;
      if (typeof settings?.updatedAt !== "string") throw new Error("Settings query returned an invalid result.");
      return { vinted, updatedAt: settings.updatedAt };
    },
  });
}
