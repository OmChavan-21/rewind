"use client";

import React, { useState } from "react";
import { Lock, Mail, User, X, CheckCircle2, AlertCircle, Loader2, KeyRound, ArrowLeft } from "lucide-react";
import type { AuthUser } from "@/types/auth";

export type AuthMode = "login" | "register" | "verify" | "forgot" | "reset";

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthSuccess: (user: AuthUser) => void;
  initialMode?: AuthMode;
  initialOobCode?: string;
}

export function AuthModal({
  isOpen,
  onClose,
  onAuthSuccess,
  initialMode = "login",
  initialOobCode = "",
}: AuthModalProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [oobCode, setOobCode] = useState(initialOobCode);
  const [verificationCode, setVerificationCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    setLoading(true);

    try {
      if (mode === "register") {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, displayName: displayName.trim() || undefined }),
        });
        const data = await res.json();
        if (!res.ok && data.accountCreated) {
          setMode("verify");
          setError(data.error || "Your account was created, but we could not send a verification code. Please try again.");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Registration failed.");
        setMode("verify");
        setSuccessMessage(data.message || `A six-digit verification code was sent to ${email}.`);
      } else if (mode === "login") {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        const data = await res.json();
        if (!res.ok || !data.user) {
          if (data.requiresEmailVerification) {
            setMode("verify");
            setVerificationCode("");
            if (data.otpSent) {
              setSuccessMessage(data.message || `A six-digit verification code was sent to ${email}.`);
            } else {
              setError(data.error || "Your email is not verified. We could not send a new code yet.");
            }
            return;
          }
          throw new Error(data.error || "Authentication failed. Please check your credentials.");
        }

        onAuthSuccess(data.user);
        onClose();
      } else if (mode === "verify") {
        const res = await fetch("/api/auth/verify-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code: verificationCode }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Email verification failed.");
        setMode("login");
        setPassword("");
        setVerificationCode("");
        setSuccessMessage("Email verified. You can now sign in.");
      } else if (mode === "forgot") {
        const res = await fetch("/api/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Failed to process password recovery request.");
        }

        setSuccessMessage(
          data.message ||
            "If an account exists with this email address, a password recovery link has been sent."
        );
      } else if (mode === "reset") {
        if (password !== confirmPassword) {
          throw new Error("Passwords do not match.");
        }
        if (password.length < 8) {
          throw new Error("Password must be at least 8 characters long.");
        }

        const res = await fetch("/api/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oobCode: oobCode.trim(), newPassword: password }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Failed to reset password. Please check your action code.");
        }

        setSuccessMessage(
          data.message || "Your password has been reset successfully. Please log in with your new password."
        );
        setPassword("");
        setConfirmPassword("");
        setOobCode("");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl relative">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center p-1.5 overflow-hidden shrink-0 shadow-inner">
              <img
                src="/brand/rewind-mark.png"
                alt="Rewind"
                className="w-full h-full object-contain filter drop-shadow-[0_0_6px_rgba(168,85,247,0.3)]"
              />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                {mode === "login" && "Sign In to Rewind"}
                {mode === "register" && "Create Developer Account"}
                {mode === "verify" && "Verify Your Email"}
                {mode === "forgot" && "Reset Your Password"}
                {mode === "reset" && "Set New Password"}
              </h3>
              <p className="text-xs text-slate-400">
                {mode === "login" && "Access your project workspaces and chat memories"}
                {mode === "register" && "Isolated multi-tenant developer workspace"}
                {mode === "verify" && "Enter the six-digit code sent to your inbox"}
                {mode === "forgot" && "Enter your email to receive a recovery link"}
                {mode === "reset" && "Enter your recovery code and choose a new password"}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher Tabs for Login/Register */}
        {(mode === "login" || mode === "register") && (
          <div className="grid grid-cols-2 p-1.5 mx-6 mt-5 bg-slate-950/80 rounded-xl border border-slate-800/80 text-xs font-medium">
            <button
              type="button"
              onClick={() => {
                setMode("login");
                setError(null);
                setSuccessMessage(null);
              }}
              className={`py-2 rounded-lg transition ${
                mode === "login"
                  ? "bg-slate-800 text-cyan-400 font-semibold shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("register");
                setError(null);
                setSuccessMessage(null);
              }}
              className={`py-2 rounded-lg transition ${
                mode === "register"
                  ? "bg-slate-800 text-cyan-400 font-semibold shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Register
            </button>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="flex items-start gap-2 p-3 text-xs bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-lg">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successMessage && (
            <div className="flex items-start gap-2 p-3 text-xs bg-teal-500/10 border border-teal-500/20 text-teal-400 rounded-lg">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}

          {mode === "register" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Display Name</label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Ada Lovelace"
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500 transition"
                />
              </div>
            </div>
          )}

          {(mode === "login" || mode === "register" || mode === "forgot" || mode === "verify") && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Email Address</label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="email"
                  required
                  value={email}
                  readOnly={mode === "verify"}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="developer@example.com"
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500 transition"
                />
              </div>
            </div>
          )}

          {mode === "verify" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Email Verification Code</label>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm tracking-[0.4em] text-center text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500 transition"
              />
              <button
                type="button"
                className="text-[11px] text-cyan-400 hover:text-cyan-300 transition"
                onClick={async () => {
                  setError(null);
                  setLoading(true);
                  try {
                    const res = await fetch("/api/auth/resend-otp", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ email }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || "Could not resend code.");
                    setSuccessMessage(data.message);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Could not resend code.");
                  } finally {
                    setLoading(false);
                  }
                }}
              >
                Resend code
              </button>
            </div>
          )}

          {mode === "reset" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Recovery Action Code</label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  required
                  value={oobCode}
                  onChange={(e) => setOobCode(e.target.value)}
                  placeholder="Paste action code from your recovery link"
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500 font-mono transition"
                />
              </div>
            </div>
          )}

          {(mode === "login" || mode === "register") && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">Password</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500 transition"
                />
              </div>
              {mode === "login" && (
                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setMode("forgot");
                      setError(null);
                      setSuccessMessage(null);
                    }}
                    className="text-[11px] text-cyan-400 hover:text-cyan-300 transition"
                  >
                    Forgot Password?
                  </button>
                </div>
              )}
            </div>
          )}

          {mode === "reset" && (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">New Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    className="w-full bg-slate-950/60 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500 transition"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300">Confirm New Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm at least 8 characters"
                    className="w-full bg-slate-950/60 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500 transition"
                  />
                </div>
              </div>
            </>
          )}

          <div className="pt-2">
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-400 hover:to-teal-400 text-slate-950 font-semibold text-xs transition flex items-center justify-center gap-2 disabled:opacity-50 shadow-md shadow-cyan-500/20"
            >
              {loading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Processing...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>
                    {mode === "login" && "Sign In"}
                    {mode === "register" && "Create Account"}
                    {mode === "verify" && "Verify Email"}
                    {mode === "forgot" && "Send Recovery Link"}
                    {mode === "reset" && "Set New Password"}
                  </span>
                </>
              )}
            </button>
          </div>

          {/* Navigation links for recovery modes */}
          {mode === "forgot" && (
            <div className="pt-2 flex items-center justify-between text-xs text-slate-400 border-t border-slate-800/80">
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setError(null);
                  setSuccessMessage(null);
                }}
                className="flex items-center gap-1 text-slate-400 hover:text-slate-200 transition"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Sign In</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("reset");
                  setError(null);
                  setSuccessMessage(null);
                }}
                className="text-cyan-400 hover:text-cyan-300 transition"
              >
                Have a reset code?
              </button>
            </div>
          )}

          {mode === "reset" && (
            <div className="pt-2 flex items-center justify-between text-xs text-slate-400 border-t border-slate-800/80">
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setError(null);
                  setSuccessMessage(null);
                }}
                className="flex items-center gap-1 text-slate-400 hover:text-slate-200 transition"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to Sign In</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("forgot");
                  setError(null);
                  setSuccessMessage(null);
                }}
                className="text-cyan-400 hover:text-cyan-300 transition"
              >
                Request a new link
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
