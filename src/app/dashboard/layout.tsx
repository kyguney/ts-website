import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getUserPlan } from "@/lib/user-entitlement";
import { SignOutButton } from "@/components/dashboard/sign-out-button";
import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/lib/utils";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/dashboard");

  const plan = await getUserPlan(session.user.id);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <BrandLogo href="/dashboard" height={72} />

            <nav className="hidden items-center gap-4 text-sm text-muted-foreground sm:flex">
              <Link href="/dashboard" className="hover:text-foreground">
                Signals
              </Link>
              <Link href="/dashboard/billing" className="hover:text-foreground">
                Billing
              </Link>
              {plan === "free" && (
                <Link href="/dashboard/upgrade" className="hover:text-foreground">
                  Upgrade
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-semibold",
                plan === "ultimate"
                  ? "bg-amber-400/15 text-amber-400"
                  : plan === "pro"
                    ? "bg-primary/15 text-primary"
                    : "bg-white/10 text-muted-foreground"
              )}
            >
              {plan === "ultimate" ? "ULTIMATE" : plan === "pro" ? "PRO" : "FREE"}
            </span>
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {session.user.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
