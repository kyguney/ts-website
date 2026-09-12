import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getUserPlan } from "@/lib/user-entitlement";
import { getUserPreferences } from "@/lib/user-preferences";
import { DashboardLive } from "@/components/dashboard/dashboard-live";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = { title: "Dashboard — TrendScore.io" };

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/dashboard");

  const plan = await getUserPlan(session.user.id);
  const preferences = await getUserPreferences(session.user.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {plan === "ultimate"
              ? "Ultimate signals"
              : plan === "pro"
                ? "Pro signals"
                : "Your signals"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {plan === "ultimate"
              ? "Fastest 1m cadence — real-time long/short scores across the full market."
              : plan === "pro"
                ? "Real-time long/short scores across the full market."
                : "Free plan — top majors, delayed. Upgrade for the full market in real time."}
          </p>
        </div>
        {plan === "free" && (
          <Button asChild>
            <Link href="/dashboard/upgrade">Upgrade to Pro</Link>
          </Button>
        )}
      </div>

      {plan === "free" && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-base">You&apos;re on the Free plan</CardTitle>
            <CardDescription>
              Unlock the full market scanner, real-time signals, and spike alerts
              with Pro.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm">
              <Link href="/dashboard/upgrade">See Pro plans</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <DashboardLive
        plan={plan}
        email={session.user.email ?? ""}
        name={session.user.name}
        initialIntervals={preferences.intervals}
        initialFavorites={preferences.favoritePairs}
        initialLeverage={preferences.defaultLeverage}
        initialRrRatio={preferences.defaultRrRatio}
      />

      <p className="text-xs text-muted-foreground">
        Real-time market data via the live signal engine. Not financial advice.
      </p>
    </div>
  );
}
