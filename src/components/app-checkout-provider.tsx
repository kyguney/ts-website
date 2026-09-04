"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { type CheckoutSerialized } from "@freemius/sdk";
import { CheckoutProvider } from "@/react-starter/components/checkout-provider";

/**
 * Wraps the Freemius CheckoutProvider with app-level behavior: on a successful
 * purchase/sync, show a toast and refresh so the new plan takes effect.
 */
export default function AppCheckoutProvider({
  children,
  checkout,
}: {
  children: React.ReactNode;
  checkout: CheckoutSerialized;
}) {
  const router = useRouter();

  const onAfterSync = React.useCallback(() => {
    toast.success("Subscription updated! Your Pro access is now active.");
    router.refresh();
  }, [router]);

  // Use the current origin in the browser so this never depends on a build-time
  // NEXT_PUBLIC_APP_URL that might be wrong (e.g. localhost baked in prod).
  const base =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_APP_URL || "";

  return (
    <CheckoutProvider
      onAfterSync={onAfterSync}
      checkout={checkout}
      endpoint={base + "/api/checkout"}
    >
      {children}
    </CheckoutProvider>
  );
}
