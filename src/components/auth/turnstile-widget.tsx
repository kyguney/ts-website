"use client";

import { useEffect, useId, useRef } from "react";

/* -------------------------------------------------------------------------- */
/* Cloudflare Turnstile — minimal typings for the global `turnstile` object.   */
/* -------------------------------------------------------------------------- */

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: "light" | "dark" | "auto";
  size?: "normal" | "flexible" | "compact";
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
  "timeout-callback"?: () => void;
}

interface TurnstileApi {
  render: (
    el: HTMLElement | string,
    options: TurnstileRenderOptions
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    onloadTurnstileCallback?: () => void;
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback";

/** Loads the Turnstile script once and resolves when `window.turnstile` is ready. */
function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();

  return new Promise<void>((resolve) => {
    // If the script tag already exists, hook into the ready callback.
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`
    );

    const prev = window.onloadTurnstileCallback;
    window.onloadTurnstileCallback = () => {
      prev?.();
      resolve();
    };

    if (window.turnstile) {
      resolve();
      return;
    }
    if (existing) return;

    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  });
}

/**
 * Dark-themed Cloudflare Turnstile widget. Renders the real challenge and
 * reports the verification token to the parent via callbacks.
 */
export function TurnstileWidget({
  siteKey,
  onVerify,
  onExpire,
  onError,
  className,
}: {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const domId = useId().replace(/:/g, "");

  useEffect(() => {
    let cancelled = false;

    loadTurnstileScript().then(() => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      // Guard against double-render (e.g. React 18 strict mode).
      if (widgetIdRef.current) return;

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme: "dark",
        size: "flexible",
        callback: (token) => onVerify(token),
        "expired-callback": () => onExpire?.(),
        "error-callback": () => onError?.(),
      });
    });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          /* widget already gone */
        }
        widgetIdRef.current = null;
      }
    };
    // siteKey is stable; callbacks are handled via refs implicitly by closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  return <div id={domId} ref={containerRef} className={className} />;
}
