"use client";

import { FormEvent, useState } from "react";
import { vintedArticleConditions, type VintedSettings } from "@/lib/vinted-settings.mts";
import { defaultGeminiSettings, maximumAutomaticEvaluationLimit, type GeminiSettings } from "@/lib/gemini-settings.mts";

type SaveState =
  | "idle"
  | "saving"
  | "saved"
  | "failed"
  | "signInRequired"
  | "unauthorized";

const preferencesCallbackPath = "/preferences";

export function PreferencesForm({ profileText, vinted = { minimumCondition: null, excludedBrands: [] }, gemini = defaultGeminiSettings }: { profileText: string; vinted?: VintedSettings; gemini?: GeminiSettings }) {
  const [value, setValue] = useState(profileText);
  const [minimumCondition, setMinimumCondition] = useState(vinted.minimumCondition ?? "");
  const [excludedBrands, setExcludedBrands] = useState(vinted.excludedBrands);
  const [automaticEvaluationLimit, setAutomaticEvaluationLimit] = useState(gemini.automaticEvaluationLimit);
  const [brandInput, setBrandInput] = useState("");
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

      if (response.status === 401) {
        setSaveState("signInRequired");
        return;
      }

      if (response.status === 403) {
        setSaveState("unauthorized");
        return;
      }

      if (!response.ok) {
        throw new Error("Preferences request failed.");
      }

      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  }

  async function saveVintedSettings() {
    setSaveState("saving");
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vinted: { minimumCondition: minimumCondition || null, excludedBrands }, gemini: { automaticEvaluationLimit } }),
      });
      if (response.status === 401) return setSaveState("signInRequired");
      if (response.status === 403) return setSaveState("unauthorized");
      if (!response.ok) throw new Error("Settings request failed.");
      setSaveState("saved");
    } catch { setSaveState("failed"); }
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
          disabled={
            saveState === "saving" ||
            saveState === "signInRequired" ||
            saveState === "unauthorized"
          }
          className="rounded-lg bg-zinc-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
        >
          {saveState === "saving" ? "Saving..." : "Save preferences"}
        </button>
        <p className="text-sm text-zinc-500" role="status" aria-live="polite">
          {saveState === "saved" ? "Saved." : null}
          {saveState === "failed" ? "Could not save preferences." : null}
          {saveState === "signInRequired" ? (
            <>
              <a
                href={`/api/auth/signin?callbackUrl=${encodeURIComponent(preferencesCallbackPath)}`}
                className="underline hover:text-zinc-950"
              >
                Sign in
              </a>
              {" "}to save preferences.
            </>
          ) : null}
          {saveState === "unauthorized"
            ? "You don't have permission to save preferences."
            : null}
        </p>
      </div>

      <div className="mt-10 border-t border-zinc-200 pt-8">
        <h2 className="text-sm font-medium text-zinc-700">Gemini</h2>
        <label htmlFor="automatic-evaluation-limit" className="mt-5 block text-sm font-medium text-zinc-700">Maximum automatic evaluations per import</label>
        <input id="automatic-evaluation-limit" type="number" min="1" max={maximumAutomaticEvaluationLimit} step="1" value={automaticEvaluationLimit} onChange={(event) => { setAutomaticEvaluationLimit(event.target.valueAsNumber); setSaveState("idle"); }} className="mt-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm" />
      </div>

      <div className="mt-10 border-t border-zinc-200 pt-8">
        <h2 className="text-sm font-medium text-zinc-700">Vinted preselection</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">Deterministic rules applied before automatic Gemini evaluation.</p>
        <label htmlFor="minimum-condition" className="mt-5 block text-sm font-medium text-zinc-700">Minimum condition</label>
        <select id="minimum-condition" value={minimumCondition} onChange={(event) => { setMinimumCondition(event.target.value); setSaveState("idle"); }} className="mt-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm">
          <option value="">No minimum</option>
          {vintedArticleConditions.map((condition) => <option key={condition} value={condition}>{condition}</option>)}
        </select>
        <label htmlFor="excluded-brand" className="mt-5 block text-sm font-medium text-zinc-700">Excluded brands</label>
        <div className="mt-2 flex flex-wrap gap-2">{excludedBrands.map((brand) => <button key={brand} type="button" onClick={() => { setExcludedBrands((brands) => brands.filter((item) => item !== brand)); setSaveState("idle"); }} className="rounded-full bg-zinc-100 px-3 py-1 text-sm">{brand} ×</button>)}</div>
        <div className="mt-2 flex gap-2"><input id="excluded-brand" value={brandInput} onChange={(event) => setBrandInput(event.target.value)} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" placeholder="Add brand" /><button type="button" onClick={() => { const brand = brandInput.trim(); if (brand && !excludedBrands.some((item) => item.toLocaleLowerCase() === brand.toLocaleLowerCase())) setExcludedBrands((brands) => [...brands, brand]); setBrandInput(""); setSaveState("idle"); }} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm">Add brand</button></div>
        <button type="button" onClick={saveVintedSettings} disabled={saveState === "saving" || saveState === "signInRequired" || saveState === "unauthorized"} className="mt-4 rounded-lg bg-zinc-950 px-4 py-2.5 text-sm font-medium text-white disabled:cursor-wait disabled:opacity-60">{saveState === "saving" ? "Saving..." : "Save settings"}</button>
      </div>
    </form>
  );
}
