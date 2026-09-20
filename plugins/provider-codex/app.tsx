import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import {
  SUBSCRIPTION_CHANGED_CHANNEL,
  type codexSubscriptionRpcContract,
  type SubscriptionStatus,
} from "./contract.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatExpiry(expiresAt: number | null): string | null {
  if (expiresAt === null) return null;
  const date = new Date(expiresAt);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function StatusDot({ tone }: { tone: "ok" | "busy" | "idle" }) {
  return (
    <span
      aria-hidden="true"
      className={
        tone === "ok"
          ? "size-2 shrink-0 rounded-full bg-success"
          : tone === "busy"
            ? "size-2 shrink-0 animate-pulse rounded-full bg-warning"
            : "size-2 shrink-0 rounded-full bg-muted-foreground/50"
      }
    />
  );
}

interface PendingLogin {
  sessionId: string;
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  intervalMs: number;
}

function CodexSubscriptionSettings() {
  const rpc = useRpc<typeof codexSubscriptionRpcContract>();
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [apiKeyEntry, setApiKeyEntry] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const activeRef = useRef(true);
  const connection = useRealtimeConnectionState();

  const refetch = useCallback(async () => {
    try {
      const next = await rpc.call("subscription.status", null);
      if (!activeRef.current) return;
      setStatus(next);
      setLoadError(null);
    } catch (error) {
      if (!activeRef.current) return;
      setLoadError(errorMessage(error));
    }
  }, [rpc]);

  useEffect(() => {
    activeRef.current = true;
    void refetch();
    return () => {
      activeRef.current = false;
    };
  }, [refetch]);

  useEffect(() => {
    if (connection === "connected") void refetch();
  }, [connection, refetch]);

  useRealtime(SUBSCRIPTION_CHANGED_CHANNEL, () => {
    void refetch();
  });

  useEffect(() => {
    if (pending === null) return;
    const update = () =>
      setCountdown(
        Math.max(0, Math.ceil((pending.expiresAt - Date.now()) / 1_000)),
      );
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [pending]);

  useEffect(() => {
    if (pending === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const result = await rpc.call("subscription.poll", {
          sessionId: pending.sessionId,
        });
        if (cancelled) return;
        if (result.state === "completed") {
          setPending(null);
          setStatus(result.status);
          setNotice("Signed in to your ChatGPT account.");
        } else if (result.state === "failed") {
          setPending(null);
          setNotice(result.error);
        } else {
          timer = setTimeout(poll, Math.max(1_000, result.nextPollMs));
        }
      } catch (error) {
        if (!cancelled) {
          setPending(null);
          setNotice(errorMessage(error));
        }
      }
    };
    timer = setTimeout(poll, Math.max(1_000, pending.intervalMs));
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [pending, rpc]);

  async function connect() {
    setBusy(true);
    setNotice(null);
    setCopied(false);
    setApiKeyEntry(false);
    try {
      const started = await rpc.call("subscription.start", null);
      if (started.state === "completed") {
        setPending(null);
        setNotice("Already signed in.");
      } else {
        setPending({
          sessionId: started.sessionId,
          verificationUri: started.verificationUri,
          userCode: started.userCode,
          expiresAt: started.expiresAt,
          intervalMs: started.intervalMs,
        });
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitApiKey(event: FormEvent) {
    event.preventDefault();
    const key = apiKey.trim();
    if (key.length === 0) {
      setNotice("Paste an API key first.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const next = await rpc.call("subscription.loginApiKey", { apiKey: key });
      setApiKey("");
      setApiKeyEntry(false);
      setStatus(next);
      setNotice("API key saved.");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (pending !== null) {
      void rpc.call("subscription.cancel", { sessionId: pending.sessionId });
    }
    setPending(null);
    setNotice(null);
  }

  async function signOut() {
    setBusy(true);
    setNotice(null);
    try {
      const next = await rpc.call("subscription.logout", null);
      setStatus(next);
      setPending(null);
      setApiKeyEntry(false);
      setNotice("Signed out.");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function copyText(text: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }

  if (status === null) {
    return (
      <p
        className={
          loadError === null
            ? "text-sm text-muted-foreground"
            : "text-sm text-destructive-text"
        }
        role={loadError === null ? "status" : "alert"}
      >
        {loadError ?? "Loading sign-in state…"}
      </p>
    );
  }

  const expiry = formatExpiry(status.expiresAt);
  const details = [
    status.mode === "apiKey" ? "API key" : null,
    status.planLabel,
    status.accountEmail,
    expiry === null ? null : `expires ${expiry}`,
  ].filter((part): part is string => part !== null);

  return (
    <div className="w-full space-y-3">
      <div className="flex items-center gap-2">
        <StatusDot
          tone={status.loggedIn ? "ok" : pending !== null ? "busy" : "idle"}
        />
        <span className="min-w-0 truncate text-sm text-foreground">
          {status.loggedIn
            ? details.length > 0
              ? `Signed in · ${details.join(" · ")}`
              : "Signed in"
            : pending !== null
              ? "Waiting for you"
              : "Signed out"}
        </span>
        <span className="flex-1" />
        {pending === null && !apiKeyEntry ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void connect()}
            >
              {status.loggedIn ? "Re-login" : "Connect"}
            </Button>
            {status.loggedIn ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                className="text-muted-foreground"
                onClick={() => {
                  setApiKeyEntry(true);
                  setNotice(null);
                }}
              >
                Use API key
              </Button>
            )}
          </>
        ) : null}
        {status.loggedIn && pending === null && !apiKeyEntry ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            className="text-muted-foreground"
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
        ) : null}
      </div>

      {pending === null ? null : (
        <div className="space-y-2.5 rounded-md border border-border px-3 py-3">
          <p className="text-sm text-muted-foreground">
            Open the verification page, sign in to ChatGPT, and enter this code.
          </p>
          <div className="rounded-lg border border-border bg-surface-recessed px-4 py-4">
            <div className="flex items-center justify-center gap-2">
              <span
                className="select-all text-center font-mono text-2xl font-semibold tracking-widest"
                aria-label="Codex user code"
              >
                {pending.userCode}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => copyText(pending.userCode)}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          <div className="flex max-w-xl items-center gap-1 rounded-lg border border-border bg-surface-recessed py-1 pl-3.5 pr-1">
            <a
              href={pending.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate font-mono text-sm text-foreground hover:underline"
            >
              {pending.verificationUri}
            </a>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyText(pending.verificationUri)}
            >
              Copy link
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm text-muted-foreground">
              Waiting for you to authorize… expires in{" "}
              {Math.floor(countdown / 60)}:
              {String(countdown % 60).padStart(2, "0")}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => void cancel()}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {apiKeyEntry && pending === null ? (
        <div className="space-y-2.5 rounded-md border border-border px-3 py-3">
          <p className="text-sm text-muted-foreground">
            Paste an OpenAI API key. It is written to the Codex CLI auth file on
            this bb host and used without a subscription.
          </p>
          <form
            className="flex max-w-md items-center gap-2"
            onSubmit={(event) => void submitApiKey(event)}
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="API key"
              autoComplete="off"
              spellCheck={false}
              aria-label="OpenAI API key"
              className="min-w-0 flex-1 font-mono"
            />
            <Button
              type="submit"
              size="sm"
              disabled={busy || apiKey.trim().length === 0}
            >
              {busy ? "Working…" : "Submit"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-muted-foreground"
              onClick={() => {
                setApiKeyEntry(false);
                setApiKey("");
                setNotice(null);
              }}
            >
              Cancel
            </Button>
          </form>
        </div>
      ) : null}

      {notice === null ? null : (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "subscription",
    title: "Subscription",
    description:
      "Use your own ChatGPT subscription for this provider's models, or paste an API key. Sign-in writes the Codex CLI credentials on this bb host.",
    component: CodexSubscriptionSettings,
  });
});
