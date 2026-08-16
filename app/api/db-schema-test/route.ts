import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

const expectedTables = ["products", "product_snapshots"];

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
    const rows = await sql`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('products', 'product_snapshots')
    `;
    const existingTables = new Set(rows.map((row) => row.tableName));

    return Response.json({
      success: true,
      tables: expectedTables.filter((table) => existingTables.has(table)),
    });
  } catch {
    return Response.json(
      {
        success: false,
        error: "Database schema check failed.",
      },
      { status: 500 },
    );
  }
}
