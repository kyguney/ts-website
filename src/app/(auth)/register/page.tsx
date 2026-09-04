import { redirect } from "next/navigation";
import { auth, enabledOAuthProviders } from "@/auth";
import { AuthShell } from "@/components/auth/auth-shell";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata = { title: "Create account — TrendScore.io" };

export default async function RegisterPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <AuthShell
      title="Create your account"
      description="Start free. Upgrade to Pro anytime."
    >
      <RegisterForm providers={enabledOAuthProviders} />
    </AuthShell>
  );
}
