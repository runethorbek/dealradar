"use client";

import { FormEvent, useState } from "react";

type SaveState = "idle" | "saving" | "saved" | "failed";

export function PreferencesForm({ profileText }: { profileText: string }) {
  const [value, setValue] = useState(profileText);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveState("saving");

    try {
      const response = await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileText: value }),
      });

      if (!response.ok) {
        throw new Error("Preferences request failed.");
      }

      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  }

  return (
    <form onSubmit={savePreferences}>
      <label htmlFor="profile-text" className="text-sm font-medium text-zinc-700">
        Preference profile
      </label>
      <p className="mt-1 text-sm leading-6 text-zinc-500">
        Describe the products, sizes, brands, and price ranges you care about.
      </p>
      <textarea
        id="profile-text"
        name="profileText"
        rows={12}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setSaveState("idle");
        }}
        placeholder="For example: I am looking for men's shoes in size 42 and tailored trousers in size 46..."
        className="mt-4 w-full resize-y rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm leading-6 outline-none transition placeholder:text-zinc-400 focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100"
      />

      <div className="mt-4 flex items-center gap-4">
        <button
          type="submit"
          disabled={saveState === "saving"}
          className="rounded-lg bg-zinc-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
        >
          {saveState === "saving" ? "Saving..." : "Save preferences"}
        </button>
        <p className="text-sm text-zinc-500" role="status" aria-live="polite">
          {saveState === "saved" ? "Saved." : null}
          {saveState === "failed" ? "Could not save preferences." : null}
        </p>
      </div>
    </form>
  );
}
