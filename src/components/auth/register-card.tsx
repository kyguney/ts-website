"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TurnstileWidget } from "./turnstile-widget";
import { GoogleIcon, GitHubIcon } from "./provider-icons";

/* -------------------------------------------------------------------------- */
/* Registration card                                                          */
/* -------------------------------------------------------------------------- */

export function RegisterCard({
  providers,
  turnstileSiteKey,
}: {
  providers: string[];
  turnstileSiteKey: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const turnstileTokenRef = useRef<string>("");
  const [turnstileReady, setTurnstileReady] = useState(false);

  const hasGoogle = providers.includes("google");
  const hasGitHub = providers.includes("github");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const token = turnstileTokenRef.current;
    if (turnstileSiteKey && !token) {
      toast.error("Please complete the human verification.");
      return;
    }

    setLoading(true);

    const form = new FormData(e.currentTarget);
    const name = String(form.get("username") || "");
    const email = String(form.get("email") || "");
    const password = String(form.get("password") || "");

    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, turnstileToken: token }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      setLoading(false);
      toast.error(data.error || "Could not create your account.");
      return;
    }

    const signInRes = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setLoading(false);

    if (signInRes?.error) {
      toast.success("Account created. Please sign in.");
      router.push("/login");
      return;
    }
    toast.success("Account created!");
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="ts-card relative w-full max-w-3xl overflow-hidden rounded-2xl p-6 shadow-2xl sm:px-12 sm:py-7">
      {/* Technical grid overlay — subtle, matching the reference. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          maskImage:
            "radial-gradient(circle at 50% 0%, black, transparent 80%)",
          WebkitMaskImage:
            "radial-gradient(circle at 50% 0%, black, transparent 80%)",
        }}
      />

      <div className="relative z-10 flex flex-col gap-4">
        {/* -------------------------------- Header ----------------------------- */}
        <div className="flex flex-col items-center gap-2 text-center">
          <Image
            src="/logo-landscape.png"
            alt="TrendScore"
            width={1962}
            height={801}
            quality={90}
            priority
            sizes="420px"
            className="h-28 w-auto object-contain"
          />

          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              Create your account
            </h1>
            <p className="text-sm text-muted-foreground sm:whitespace-nowrap">
              Access institutional-grade quantitative signals and climb the
              leaderboard.
            </p>
          </div>
        </div>

        {/* ---------------------------- Social auth --------------------------- */}
        <div className="grid grid-cols-2 gap-3">
          <Button
            type="button"
            variant="secondary"
            className="h-11 w-full border border-border bg-secondary/60 text-sm hover:bg-secondary"
            onClick={() =>
              hasGoogle && signIn("google", { callbackUrl: "/dashboard" })
            }
            disabled={!hasGoogle}
          >
            <GoogleIcon />
            <span className="truncate">Continue with Google</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="h-11 w-full border border-border bg-secondary/60 text-sm hover:bg-secondary"
            onClick={() =>
              hasGitHub && signIn("github", { callbackUrl: "/dashboard" })
            }
            disabled={!hasGitHub}
          >
            <GitHubIcon />
            <span className="truncate">Continue with GitHub</span>
          </Button>
        </div>

        {/* Divider */}
        <div className="relative text-center text-xs text-muted-foreground">
          <span className="relative z-10 bg-card px-3">or register with email</span>
          <span className="absolute inset-x-0 top-1/2 -z-0 h-px -translate-y-1/2 bg-border" />
        </div>

        {/* ------------------------------- Form ------------------------------- */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Username */}
          <div className="grid gap-1.5">
            <Label htmlFor="username" className="text-foreground">
              Username
            </Label>
            <Input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              placeholder="e.g. Satoshi_99"
              className="h-11 focus-visible:border-[var(--ts-emerald)] focus-visible:ring-[var(--ts-emerald)]/40"
              required
            />
            <p className="text-xs text-muted-foreground">
              Visible on public rankings and the leaderboard.
            </p>
          </div>

          {/* Email */}
          <div className="grid gap-1.5">
            <Label htmlFor="email" className="text-foreground">
              Email address
            </Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="trader@domain.com"
              className="h-11 focus-visible:border-[var(--ts-emerald)] focus-visible:ring-[var(--ts-emerald)]/40"
              required
            />
          </div>

          {/* Password */}
          <div className="grid gap-1.5">
            <Label htmlFor="password" className="text-foreground">
              Password
            </Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                placeholder="••••••••••••"
                minLength={8}
                className="h-11 pr-11 focus-visible:border-[var(--ts-emerald)] focus-visible:ring-[var(--ts-emerald)]/40"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 flex items-center rounded-r-md px-3 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ts-emerald)]/40"
              >
                {showPassword ? (
                  <EyeOff className="size-5" />
                ) : (
                  <Eye className="size-5" />
                )}
              </button>
            </div>
          </div>

          {/* --------------------- Bot protection (Turnstile) ------------------- */}
          {turnstileSiteKey ? (
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              className="min-h-[65px] w-full [color-scheme:dark]"
              onVerify={(token) => {
                turnstileTokenRef.current = token;
                setTurnstileReady(true);
              }}
              onExpire={() => {
                turnstileTokenRef.current = "";
                setTurnstileReady(false);
              }}
              onError={() => {
                turnstileTokenRef.current = "";
                setTurnstileReady(false);
              }}
            />
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/60 px-4 py-3 text-sm text-muted-foreground">
              <span>Human verification unavailable (missing site key).</span>
            </div>
          )}

          {/* ------------------------------ CTA ------------------------------- */}
          <Button
            type="submit"
            className="ts-cta h-12 w-full rounded-xl text-base font-semibold"
            disabled={loading || (!!turnstileSiteKey && !turnstileReady)}
          >
            {loading ? "Creating account…" : "Create Account"}
          </Button>
        </form>

        {/* ---------------------------- Footer links -------------------------- */}
        <div className="space-y-3 text-center">
          <p className="text-xs text-muted-foreground">
            By signing up, you agree to the{" "}
            <Link
              href="/terms"
              className="font-medium text-foreground hover:underline"
            >
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link
              href="/privacy"
              className="font-medium text-foreground hover:underline"
            >
              Privacy Policy
            </Link>
            .
          </p>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href="/login"
              className="font-semibold text-[var(--ts-emerald-2)] hover:underline"
            >
              Log in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
