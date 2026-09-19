import type { OwnerAuthorization } from "./owner-authorization.mts";
import { parseGeminiSettings, type GeminiSettings } from "./gemini-settings.mts";
import { parseVintedSettings, type VintedSettings } from "./vinted-settings.mts";
import { parseBrandFilterSettings, type BrandFilterSettings } from "./brand-filter-settings.mts";
import { parseRankingSettings, type RankingSettings } from "./ranking-settings.mts";

type SavedSettings = { vinted: VintedSettings; gemini?: GeminiSettings; brandFilter?: BrandFilterSettings; ranking?: RankingSettings; updatedAt: string };
type SettingsHandlerDependencies = {
  authorize: () => Promise<OwnerAuthorization>;
  save: (vinted: VintedSettings, gemini?: GeminiSettings, brandFilter?: BrandFilterSettings, ranking?: RankingSettings) => Promise<SavedSettings>;
};

export async function handleSettingsPost(request: Request, dependencies: SettingsHandlerDependencies) {
  const authorization = await dependencies.authorize();
  if (authorization.status === "unauthenticated") return Response.json({ success: false, error: "Unauthorized." }, { status: 401 });
  if (authorization.status === "unauthorized") return Response.json({ success: false, error: "Forbidden." }, { status: 403 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ success: false, error: "Invalid JSON body." }, { status: 400 }); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return Response.json({ success: false, error: "Invalid settings." }, { status: 400 });

  const vinted = parseVintedSettings((body as Record<string, unknown>).vinted);
  if (!vinted) return Response.json({ success: false, error: "Invalid Vinted settings." }, { status: 400 });
  const geminiValue = (body as Record<string, unknown>).gemini;
  let gemini: GeminiSettings | undefined;
  if (geminiValue !== undefined) {
    const parsedGemini = parseGeminiSettings(geminiValue);
    if (!parsedGemini) return Response.json({ success: false, error: "Invalid Gemini settings." }, { status: 400 });
    gemini = parsedGemini;
  }

  const brandFilterValue = (body as Record<string, unknown>).brandFilter;
  let brandFilter: BrandFilterSettings | undefined;
  if (brandFilterValue !== undefined) {
    const parsedBrandFilter = parseBrandFilterSettings(brandFilterValue);
    if (!parsedBrandFilter) return Response.json({ success: false, error: "Invalid brand filter settings." }, { status: 400 });
    brandFilter = parsedBrandFilter;
  }

  const rankingValue = (body as Record<string, unknown>).ranking;
  let ranking: RankingSettings | undefined;
  if (rankingValue !== undefined) {
    const parsedRanking = parseRankingSettings(rankingValue);
    if (!parsedRanking) return Response.json({ success: false, error: "Invalid ranking settings." }, { status: 400 });
    ranking = parsedRanking;
  }

  try {
    return Response.json({ success: true, ...(await dependencies.save(vinted, gemini, brandFilter, ranking)) });
  } catch {
    return Response.json({ success: false, error: "Settings could not be saved." }, { status: 500 });
  }
}
