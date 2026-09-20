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
  type claudeSubscriptionRpcContract,
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
  authorizeUrl: string;
}

function ClaudeSubscriptionSettings() {
  const rpc = useRpc<typeof claudeSubscriptionRpcContract>();
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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

  async function connect() {
    setBusy(true);
    setNotice(null);
    setCopied(false);
    try {
      const started = await rpc.call("subscription.start", null);
      if (started.state === "completed") {
        setPending(null);
        setNotice("Already signed in.");
      } else {
        setPending({
          sessionId: started.sessionId,
          authorizeUrl: started.authorizeUrl,
        });
        setCode("");
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const pasted = code.trim();
    if (pending === null || pasted.length === 0) {
      setNotice("Paste the authorization code first.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const next = await rpc.call("subscription.complete", {
        sessionId: pending.sessionId,
        code: pasted,
      });
      setPending(null);
      setCode("");
      setStatus(next);
      setNotice("Signed in to your Claude account.");
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
    setCode("");
    setNotice(null);
  }

  async function signOut() {
    setBusy(true);
    setNotice(null);
    try {
      const next = await rpc.call("subscription.logout", null);
      setStatus(next);
      setPending(null);
      setNotice("Signed out.");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url).then(
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
        {pending === null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void connect()}
          >
            {status.loggedIn ? "Re-login" : "Connect"}
          </Button>
        ) : null}
        {status.loggedIn && pending === null ? (
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
            Open this link, authorize with your Claude account, then paste the
            code it shows below.
          </p>
          <div className="flex max-w-xl items-center gap-1 rounded-lg border border-border bg-surface-recessed py-1 pl-3.5 pr-1">
            <a
              href={pending.authorizeUrl}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 flex-1 truncate font-mono text-sm text-foreground hover:underline"
            >
              {pending.authorizeUrl}
            </a>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copyUrl(pending.authorizeUrl)}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <form
            className="flex max-w-md items-center gap-2"
            onSubmit={(event) => void submit(event)}
          >
            <Input
              type="password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Paste code#state here"
              autoComplete="off"
              spellCheck={false}
              aria-label="Claude authorization code"
              className="min-w-0 flex-1 font-mono"
            />
            <Button
              type="submit"
              size="sm"
              disabled={busy || code.trim().length === 0}
            >
              {busy ? "Working…" : "Submit"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-muted-foreground"
              onClick={() => void cancel()}
            >
              Cancel
            </Button>
          </form>
        </div>
      )}

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
      "Use your own Claude subscription for this provider's models. Sign-in writes the Claude CLI credentials on this bb host.",
    component: ClaudeSubscriptionSettings,
  });
});
