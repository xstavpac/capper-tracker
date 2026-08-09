import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// Google-only sign-in (replaces Clerk). JWT session strategy - no NextAuth-
// owned Account/Session/VerificationToken tables, session state lives only
// in a signed cookie. The app's own `users` table (see server/auth.ts) stays
// the single source of truth for who a user is; this just authenticates
// them and hands back Google's profile (id/email/name/picture) on sign-in.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/sign-in" },
  // Vercel (and most PaaS) proxy requests, so the Host header Auth.js sees
  // is legitimate even without an exact AUTH_URL match - without this,
  // every request fails an UntrustedHost check and auth() never resolves a
  // session, silently breaking sign-in even with valid credentials.
  trustHost: true,
  callbacks: {
    // Carries the Google subject id (`sub`) through the JWT so `auth()`
    // callers can look up/create the app's own User row without a second
    // network round-trip for profile data (Clerk's currentUser() equivalent
    // isn't needed here - Google's profile comes in on the initial sign-in
    // and gets persisted into our own `users` table right away).
    async jwt({ token, profile }) {
      if (profile?.sub) token.googleId = profile.sub;
      return token;
    },
    async session({ session, token }) {
      if (token.googleId) (session as any).googleId = token.googleId;
      return session;
    },
  },
});
