import { neon } from "@neondatabase/serverless";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { connection } from "next/server";
import { authOptions } from "@/auth";
import { PreferencesForm } from "./preferences-form";
import { AppNavigation } from "../navigation";

async function getPreferences() {
  await connection();

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return { profileText: "", failed: true };
  }

  try {
    const sql = neon(databaseUrl);
    const [preference] = await sql`
      SELECT profile_text AS "profileText"
      FROM preferences
      WHERE id = 1
    `;

    return {
      profileText:
        typeof preference?.profileText === "string" ? preference.profileText : "",
      failed: false,
    };
  } catch {
    return { profileText: "", failed: true };
  }
}

export default async function PreferencesPage() {
  const [{ profileText, failed }, session] = await Promise.all([
    getPreferences(),
    getServerSession(authOptions),
  ]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950">
      <AppNavigation
        session={session}
        currentPage="preferences"
        callbackPath="/preferences"
      />

      <main className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="mb-8">
          <p className="text-sm font-medium text-zinc-500">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Preferences
          </h1>
        </div>

        <section className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          {failed ? (
            <p className="text-sm text-zinc-500">
              Preferences could not be loaded right now.
            </p>
          ) : (
            <PreferencesForm profileText={profileText} />
          )}
        </section>
      </main>
    </div>
  );
}
