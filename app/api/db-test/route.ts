import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

function getSafeErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : "An unknown database error occurred.";
  const databaseUrl = process.env.DATABASE_URL;

  const withoutConfiguredUrl = databaseUrl
    ? message.replaceAll(databaseUrl, "[redacted]")
    : message;

  return withoutConfiguredUrl.replace(
    /postgres(?:ql)?:\/\/[^\s"'<>]+/gi,
    "[redacted]",
  );
}

export async function GET() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return Response.json(
      {
        success: false,
        error: "DATABASE_URL is not configured on the server.",
      },
      { status: 500 },
    );
  }

  try {
    const sql = neon(databaseUrl);
    const [result] = await sql`SELECT NOW() AS "databaseTime"`;

    return Response.json({
      success: true,
      databaseTime: result.databaseTime,
    });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: `Database query failed: ${getSafeErrorMessage(error)}`,
      },
      { status: 500 },
    );
  }
}
