"use client";

import { useState, useRef } from "react";

const isValidEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

type NoteState = {
  message: string;
  type: "" | "is-error" | "is-success";
};

const DEFAULT_NOTE: NoteState = {
  message: "Join the waitlist. No spam — just the launch.",
  type: "",
};

export default function WaitlistForm({
  variant = "legacy",
}: {
  variant?: "legacy" | "modern";
}) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState<NoteState>(DEFAULT_NOTE);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();

    if (!isValidEmail(value)) {
      setNote({ message: "Please enter a valid email address.", type: "is-error" });
      inputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Request failed");
      }

      setNote({
        message: data.duplicate
          ? "You're already on the list — see you at launch! 🚀"
          : "You're on the list! We'll email you at launch. 🚀",
        type: "is-success",
      });
      setEmail("");
    } catch {
      setNote({
        message: "Something went wrong. Please try again in a moment.",
        type: "is-error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (variant === "modern") {
    const noteColor =
      note.type === "is-error"
        ? "text-[var(--ts-red)]"
        : note.type === "is-success"
          ? "text-[var(--ts-emerald)]"
          : "text-[var(--ts-text-muted)]";
    return (
      <form className="w-full max-w-md" onSubmit={handleSubmit} noValidate>
        <div className="ts-card flex items-center gap-2 p-1.5">
          <input
            ref={inputRef}
            type="email"
            name="email"
            placeholder="you@email.com"
            autoComplete="email"
            aria-label="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            required
            className="min-w-0 flex-1 bg-transparent px-4 py-2.5 text-sm text-[var(--ts-text)] placeholder:text-[var(--ts-text-muted)] outline-none"
          />
          <button
            type="submit"
            disabled={submitting}
            className="ts-cta shrink-0 whitespace-nowrap rounded-[calc(1rem-6px)] px-5 py-2.5 text-sm disabled:opacity-70"
          >
            {submitting ? "Saving…" : "Get Early Access"}
          </button>
        </div>
        <p className={`mt-2.5 text-xs ${noteColor}`} role="status" aria-live="polite">
          {note.message}
        </p>
      </form>
    );
  }

  return (
    <form className="waitlist" onSubmit={handleSubmit} noValidate>
      <div className="waitlist__field">
        <input
          ref={inputRef}
          type="email"
          name="email"
          placeholder="you@email.com"
          autoComplete="email"
          aria-label="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          required
        />
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Get Early Access"}
        </button>
      </div>
      <p
        className={`waitlist__note ${note.type}`}
        role="status"
        aria-live="polite"
      >
        {note.message}
      </p>
    </form>
  );
}
