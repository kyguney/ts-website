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

export default function WaitlistForm() {
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
