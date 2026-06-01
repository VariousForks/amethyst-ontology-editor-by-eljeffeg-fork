import { useEffect, useState } from "react";
import { useAuth } from "../App.jsx";
import { api } from "../lib/api.js";

export default function AuthView() {
  const { hasUsers, registrationDisabled, googleEnabled, setUser } = useAuth();
  // Self-registration is always allowed when no users exist yet (first-run
  // admin bootstrap), even if an admin later sets the disabled flag.
  const canRegister = !hasUsers || !registrationDisabled;
  const [mode, setMode] = useState(!hasUsers ? "register" : canRegister ? "login" : "login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  // Surface any error forwarded from the Google OAuth callback redirect,
  // e.g. /login?error=oauth_failed or /login?error=registration_disabled.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get("error");
    if (oauthError) {
      const messages = {
        registration_disabled: "Registration is disabled. Ask an administrator for an invite.",
        oauth_failed: "Google sign-in failed. Please try again.",
        invalid_state: "OAuth session expired or was tampered with. Please try again.",
        access_denied: "Google sign-in was cancelled.",
      };
      setErr(messages[oauthError] ?? `Sign-in error: ${oauthError}`);
      // Remove the query param so a page refresh doesn't re-show the error.
      window.history.replaceState({}, "", "/login");
    }
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (mode === "register" && password !== confirmPassword) {
      setErr("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      // Use the user returned by the login/register response directly.
      // This avoids a race where the session cookie hasn't been committed to
      // the store yet when the follow-up /status request fires.
      const data =
        mode === "login"
          ? await api.login(username, password)
          : await api.register(username, email, password);
      setUser(data.user);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleSignIn = () => {
    // Full page navigation — the server will redirect to Google and then back.
    window.location.href = "/api/auth/google";
  };

  return (
    <div className="h-screen grid place-items-center px-6">
      <div className="w-full max-w-md panel p-8">
        <div className="flex items-center gap-3 mb-6 justify-center">
          <img src="/logo.png" alt="Amethyst logo" className="h-14" />
        </div>

        {!hasUsers && mode === "register" && (
          <div className="mb-4 text-xs text-brand-200 bg-brand-900/40 border border-brand-500/40 rounded-md p-3">
            No users exist yet. The first account you create becomes the admin.
          </div>
        )}

        {/* Google Sign-In — shown whenever the server has Google OAuth configured */}
        {googleEnabled && (
          <div className="mb-5">
            <button
              type="button"
              onClick={handleGoogleSignIn}
              className="w-full flex items-center justify-center gap-3 rounded-md border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-700 active:bg-slate-600 transition-colors"
            >
              <GoogleIcon />
              Continue with Google
            </button>

            <div className="relative flex items-center mt-5">
              <div className="flex-1 border-t border-slate-700" />
              <span className="px-3 text-xs text-slate-500">or sign in with username</span>
              <div className="flex-1 border-t border-slate-700" />
            </div>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label" htmlFor="auth-username">
              Username
            </label>
            <input
              id="auth-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="auth-password">
              Password
            </label>
            <input
              id="auth-password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          {mode === "register" && (
            <div>
              <label className="label" htmlFor="auth-confirm-password">
                Confirm password
              </label>
              <input
                id="auth-confirm-password"
                className={`input ${confirmPassword && confirmPassword !== password ? "border-red-500/60 focus:border-red-400" : ""}`}
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={6}
              />
              {confirmPassword && confirmPassword !== password && (
                <p className="mt-1 text-xs text-red-400">Passwords do not match.</p>
              )}
            </div>
          )}
          {mode === "register" && (
            <div>
              <label className="label" htmlFor="auth-email">
                Email <span className="capitalize">(optional - used for team collaboration)</span>
              </label>
              <input
                id="auth-email"
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          )}
          {err && <div className="text-sm text-red-300">{err}</div>}
          <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="mt-4 text-sm text-slate-400 text-center">
          {mode === "login" ? (
            canRegister ? (
              <>
                Need an account?{" "}
                <button
                  type="button"
                  className="text-brand-300 hover:underline"
                  onClick={() => setMode("register")}
                >
                  Register
                </button>
              </>
            ) : (
              <span className="text-xs text-slate-500">
                Self-registration is disabled. Ask an administrator for an account.
              </span>
            )
          ) : (
            <>
              Already have an account?{" "}
              <button
                type="button"
                className="text-brand-300 hover:underline"
                onClick={() => setMode("login")}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Official Google "G" logo mark (single-colour simplified version).
function GoogleIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width="18"
      height="18"
      aria-hidden="true"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
      <path fill="none" d="M0 0h48v48H0z" />
    </svg>
  );
}
