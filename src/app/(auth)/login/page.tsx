import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth, enabledOAuthProviders } from "@/auth";
import { ComingSoonShell } from "@/components/auth/coming-soon-shell";
import { LoginCard } from "@/components/auth/login-card";

export const metadata = { title: "Sign in — TrendScore.io" };

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <ComingSoonShell showBull={false} facetsVariant="sides" showBackToHome>
      <Suspense>
        <LoginCard
          providers={enabledOAuthProviders}
          turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ""}
        />
      </Suspense>
    </ComingSoonShell>
  );
}
