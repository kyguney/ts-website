import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getFreemius, IS_FREEMIUS_SANDBOX } from "@/lib/freemius";
import AppCheckoutProvider from "@/components/app-checkout-provider";
import { CustomerPortal } from "@/react-starter/components/customer-portal";

export const metadata = { title: "Billing — TrendScore.io" };

export default async function BillingPage() {
  const session = await auth();
  if (!session?.user) redirect("/login?callbackUrl=/dashboard/billing");

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
        <h1 className="text-2xl font-bold tracking-tight">Billing & subscription</h1>
        <p className="text-sm text-muted-foreground">
          Manage your subscription, payment method, and invoices.
        </p>
      </div>

      <AppCheckoutProvider checkout={checkout.serialize()}>
        <CustomerPortal endpoint="/api/portal" />
      </AppCheckoutProvider>
    </div>
  );
}
