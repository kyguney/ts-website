import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth, enabledOAuthProviders } from "@/auth";
import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";

export const metadata = { title: "Sign in — TrendScore.io" };

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <AuthShell title="Sign in" description="Welcome back to TrendScore.">
      <Suspense>
        <LoginForm providers={enabledOAuthProviders} />
      </Suspense>
    </AuthShell>
  );
}
