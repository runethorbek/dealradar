import Link from "next/link";
import type { Session } from "next-auth";

export function AppNavigation({
  session,
  callbackPath,
  currentPage,
}: {
  session: Session | null;
  callbackPath: string;
  currentPage: "dashboard" | "preferences";
}) {
  const authPath = session
    ? `/api/auth/signout?callbackUrl=${encodeURIComponent(callbackPath)}`
    : `/api/auth/signin?callbackUrl=${encodeURIComponent(callbackPath)}`;

  return (
    <header className="border-b border-zinc-200 bg-white">
      <div className="mx-auto flex h-16 max-w-6xl items-center px-6 lg:px-8">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-950 text-sm font-semibold text-white">
          D
        </span>
        <Link
          href="/"
          className="ml-3 text-lg font-semibold tracking-tight"
        >
          DealRadar
        </Link>
        {currentPage === "dashboard" ? (
          <Link
            href="/preferences"
            className="ml-auto text-sm font-medium text-zinc-500 transition hover:text-zinc-950"
          >
            Preferences
          </Link>
        ) : (
          <Link
            href="/"
            className="ml-auto text-sm font-medium text-zinc-500 transition hover:text-zinc-950"
          >
            Dashboard
          </Link>
        )}
        <Link
          href={authPath}
          className="ml-4 text-sm font-medium text-zinc-500 transition hover:text-zinc-950"
        >
          {session ? "Sign out" : "Sign in"}
        </Link>
      </div>
    </header>
  );
}
