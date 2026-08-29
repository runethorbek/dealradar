import type { OwnerAuthorization } from "@/lib/owner-authorization.mts";

type SavedPreference = { profileText: string; updatedAt: string };

type PreferencesHandlerDependencies = {
  authorize: () => Promise<OwnerAuthorization>;
  save: (profileText: string) => Promise<SavedPreference>;
};

function authorizationResponse(authorization: OwnerAuthorization) {
  if (authorization.status === "unauthenticated") {
    return Response.json({ success: false, error: "Unauthorized." }, { status: 401 });
  }
  if (authorization.status === "unauthorized") {
    return Response.json({ success: false, error: "Forbidden." }, { status: 403 });
  }
  return null;
}

export async function handlePreferencesPost(
  request: Request,
  dependencies: PreferencesHandlerDependencies,
) {
  const rejectedResponse = authorizationResponse(await dependencies.authorize());
  if (rejectedResponse) return rejectedResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ success: false, error: "Invalid preference profile." }, { status: 400 });
  }

  const profileText = (body as Record<string, unknown>).profileText;
  if (typeof profileText !== "string") {
    return Response.json({ success: false, error: "Profile text must be a string." }, { status: 400 });
  }

  try {
    const preference = await dependencies.save(profileText);
    return Response.json({ success: true, ...preference });
  } catch {
    return Response.json({ success: false, error: "Preferences could not be saved." }, { status: 500 });
  }
}
