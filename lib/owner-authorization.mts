export type AuthenticatedUser = {
  email?: string | null;
  emailVerified?: boolean;
};

export type OwnerAuthorization =
  | { status: "authorized" }
  | { status: "unauthenticated" }
  | { status: "unauthorized" };

function isConfiguredLowercaseEmail(value: string | undefined) {
  return Boolean(value && value === value.trim() && value === value.toLowerCase());
}

export function authorizeOwner(
  user: AuthenticatedUser | null | undefined,
  ownerEmail = process.env.OWNER_EMAIL,
): OwnerAuthorization {
  if (!user) return { status: "unauthenticated" };

  if (
    !user.emailVerified ||
    !user.email ||
    user.email !== user.email.toLowerCase() ||
    !isConfiguredLowercaseEmail(ownerEmail) ||
    user.email !== ownerEmail
  ) {
    return { status: "unauthorized" };
  }

  return { status: "authorized" };
}
