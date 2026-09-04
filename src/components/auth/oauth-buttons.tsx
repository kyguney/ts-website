"use client";

import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";

const PROVIDER_LABELS: Record<string, string> = {
  google: "Continue with Google",
  "microsoft-entra-id": "Continue with Microsoft",
};

export function OAuthButtons({
  providers,
  callbackUrl,
}: {
  providers: string[];
  callbackUrl: string;
}) {
  if (providers.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {providers.map((id) => (
        <Button
          key={id}
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => signIn(id, { callbackUrl })}
        >
          {PROVIDER_LABELS[id] ?? `Continue with ${id}`}
        </Button>
      ))}
      <div className="relative my-2 text-center text-xs text-muted-foreground">
        <span className="relative z-10 bg-background px-2">or</span>
        <span className="absolute inset-x-0 top-1/2 -z-0 h-px -translate-y-1/2 bg-border" />
      </div>
    </div>
  );
}
