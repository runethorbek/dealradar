const sections = [
  {
    title: "Latest deals",
    description: "New deals will appear here as they are discovered.",
  },
  {
    title: "Sources",
    description: "Your monitored stores and websites will appear here.",
  },
  {
    title: "Price history",
    description: "Price changes over time will appear here.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center px-6 lg:px-8">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-950 text-sm font-semibold text-white">
            D
          </span>
          <h1 className="ml-3 text-lg font-semibold tracking-tight">DealRadar</h1>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="mb-8">
          <p className="text-sm font-medium text-zinc-500">Dashboard</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">
            Your deals at a glance
          </h2>
        </div>

        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {sections.map((section) => (
            <section
              key={section.title}
              className="min-h-48 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm"
            >
              <h3 className="text-base font-semibold">{section.title}</h3>
              <div className="mt-5 flex min-h-24 items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-6 text-center">
                <p className="max-w-56 text-sm leading-6 text-zinc-500">
                  {section.description}
                </p>
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
