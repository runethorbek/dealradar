import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

const thirtyDaysInSeconds = 30 * 24 * 60 * 60;

function googleEmailWasVerified(profile: unknown) {
  return (
    typeof profile === "object" &&
    profile !== null &&
    (profile as Record<string, unknown>).email_verified === true
  );
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  session: { strategy: "jwt", maxAge: thirtyDaysInSeconds },
  callbacks: {
    async jwt({ token, profile }) {
      if (profile) token.emailVerified = googleEmailWasVerified(profile);
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.emailVerified = token.emailVerified === true;
      return session;
    },
  },
};
