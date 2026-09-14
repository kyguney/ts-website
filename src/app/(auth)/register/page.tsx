import { redirect } from "next/navigation";
import { auth, enabledOAuthProviders } from "@/auth";
import { ComingSoonShell } from "@/components/auth/coming-soon-shell";
import { RegisterCard } from "@/components/auth/register-card";

export const metadata = { title: "Create account — TrendScore.io" };

export default async function RegisterPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <ComingSoonShell showBull={false} facetsVariant="sides" showBackToHome>
      <RegisterCard
        providers={enabledOAuthProviders}
        turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ""}
      />
    </ComingSoonShell>
  );
}
