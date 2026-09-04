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

  return (
    <CheckoutProvider
      onAfterSync={onAfterSync}
      checkout={checkout}
      endpoint={process.env.NEXT_PUBLIC_APP_URL! + "/api/checkout"}
    >
      {children}
    </CheckoutProvider>
  );
}
