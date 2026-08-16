import { neon } from "@neondatabase/serverless";

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

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json(
      { success: false, error: "Invalid preference profile." },
      { status: 400 },
    );
  }

  const profileText = (body as Record<string, unknown>).profileText;

  if (typeof profileText !== "string") {
    return Response.json(
      { success: false, error: "Profile text must be a string." },
      { status: 400 },
    );
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return Response.json(
      { success: false, error: "Preferences could not be saved." },
      { status: 500 },
    );
  }

  try {
    const sql = neon(databaseUrl);
    const [preference] = await sql`
      INSERT INTO preferences (id, profile_text)
      VALUES (1, ${profileText})
      ON CONFLICT (id) DO UPDATE SET
        profile_text = EXCLUDED.profile_text,
        updated_at = NOW()
      RETURNING
        profile_text AS "profileText",
        updated_at::TEXT AS "updatedAt"
    `;

    return Response.json({
      success: true,
      profileText: preference.profileText,
      updatedAt: preference.updatedAt,
    });
  } catch {
    return Response.json(
      { success: false, error: "Preferences could not be saved." },
      { status: 500 },
    );
  }
}
