import type { OwnerAuthorization } from "./owner-authorization.mts";
import { parseGeminiSettings, type GeminiSettings } from "./gemini-settings.mts";
import { parseVintedSettings, type VintedSettings } from "./vinted-settings.mts";

type SavedSettings = { vinted: VintedSettings; gemini?: GeminiSettings; updatedAt: string };
type SettingsHandlerDependencies = {
  authorize: () => Promise<OwnerAuthorization>;
  save: (vinted: VintedSettings, gemini?: GeminiSettings) => Promise<SavedSettings>;
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

  try {
    return Response.json({ success: true, ...(await dependencies.save(vinted, gemini)) });
  } catch {
    return Response.json({ success: false, error: "Settings could not be saved." }, { status: 500 });
  }
}
