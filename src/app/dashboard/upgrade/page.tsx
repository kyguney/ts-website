import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getFreemius, IS_FREEMIUS_SANDBOX } from "@/lib/freemius";
import { getUserPlan } from "@/lib/user-entitlement";
import AppCheckoutProvider from "@/components/app-checkout-provider";
import { Subscribe } from "@/react-starter/components/subscribe";

export const metadata = { title: "Upgrade — TrendScore.io" };

export default async function UpgradePage() {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/dashboard/upgrade");

  // Already Pro — no need to see the pricing table.
  const plan = await getUserPlan(session.user.id);
  if (plan === "pro") redirect("/dashboard/billing");

  const checkout = await getFreemius().checkout.create({
    user: {
      email: session.user.email!,
      name: session.user.name ?? undefined,
    },
    isSandbox: IS_FREEMIUS_SANDBOX,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Upgrade to Pro</h1>
        <p className="text-sm text-muted-foreground">
          Unlock the full market scanner, real-time signals, and spike alerts.
        </p>
        {IS_FREEMIUS_SANDBOX && (
          <p className="mt-2 inline-block rounded-md bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-400">
            Sandbox mode — use test card 4242 4242 4242 4242 (no real charge).
          </p>
        )}
      </div>

      <AppCheckoutProvider checkout={checkout.serialize()}>
        <Subscribe />
      </AppCheckoutProvider>
    </div>
  );
}
