import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & { emailVerified?: boolean };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    emailVerified?: boolean;
  }
}

export {};
