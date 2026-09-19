import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import {
  AUTH_REALTIME_CHANNEL,
  loginSessionSchema,
  PLUGIN_ID,
  PROVIDERS,
  PROVIDER_LABELS,
  providerStatusSchema,
  ROUTES,
  type LoginSession,
  type ProviderId,
  type ProviderStatus,
} from "./contract.js";

const HTTP_BASE = `/api/v1/plugins/${PLUGIN_ID}/http`;
const JSON_HEADERS = { "content-type": "application/json" };

function readErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null) {
    const error = Reflect.get(payload, "error");
    if (typeof error === "object" && error !== null) {
      const message = Reflect.get(error, "message");
      if (typeof message === "string" && message.length > 0) return message;
    }
    const session = loginSessionSchema.safeParse(payload);
    if (session.success && session.data.error !== null)
      return session.data.error;
  }
  return fallback;
}

async function postSession(
  routePath: string,
  body: unknown,
): Promise<LoginSession> {
  const response = await fetch(`${HTTP_BASE}${routePath}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      readErrorMessage(payload, `Request failed (HTTP ${response.status}).`),
    );
  }
  return loginSessionSchema.parse(payload);
}

async function fetchStatus(provider: ProviderId): Promise<ProviderStatus> {
  const response = await fetch(
    `${HTTP_BASE}${ROUTES.status}?provider=${provider}`,
    { headers: JSON_HEADERS },
  );
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      readErrorMessage(payload, `Request failed (HTTP ${response.status}).`),
    );
  }
  return providerStatusSchema.parse(payload);
}

async function cancelLogin(provider: ProviderId): Promise<void> {
  const response = await fetch(
    `${HTTP_BASE}${ROUTES.login}?provider=${provider}`,
    { method: "DELETE", headers: JSON_HEADERS },
  );
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(
      readErrorMessage(payload, `Request failed (HTTP ${response.status}).`),
    );
  }
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

interface ProviderRowState {
  status: ProviderStatus | null;
  pendingUrl: string | null | undefined;
  secret: string;
  busy: boolean;
  notice: string | null;
  copied: boolean;
}

const INITIAL_ROW: ProviderRowState = {
  status: null,
  pendingUrl: undefined,
  secret: "",
  busy: false,
  notice: null,
  copied: false,
};

function ProviderAuthSettings() {
  const [rows, setRows] = useState<Record<ProviderId, ProviderRowState>>({
    claude: { ...INITIAL_ROW },
    codex: { ...INITIAL_ROW },
  });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const connection = useRealtimeConnectionState();

  const patchRow = useCallback(
    (provider: ProviderId, patch: Partial<ProviderRowState>) => {
      setRows((current) => ({
        ...current,
        [provider]: { ...current[provider], ...patch },
      }));
    },
    [],
  );

  const refetch = useCallback(async () => {
    try {
      const [claude, codex] = await Promise.all([
        fetchStatus("claude"),
        fetchStatus("codex"),
      ]);
      setRows((current) => ({
        claude: { ...current.claude, status: claude },
        codex: { ...current.codex, status: codex },
      }));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    if (connection === "connected") void refetch();
  }, [connection, refetch]);

  useRealtime(AUTH_REALTIME_CHANNEL, () => {
    void refetch();
  });

  async function start(provider: ProviderId) {
    patchRow(provider, { busy: true, notice: null, copied: false });
    try {
      const session = await postSession(ROUTES.start, { provider });
      if (session.state === "completed") {
        patchRow(provider, {
          pendingUrl: undefined,
          notice: "Already signed in.",
        });
      } else if (session.state === "failed") {
        patchRow(provider, {
          pendingUrl: undefined,
          notice: session.error ?? "Login could not start.",
        });
      } else {
        patchRow(provider, { pendingUrl: session.url });
      }
      void refetch();
    } catch (error) {
      patchRow(provider, {
        pendingUrl: undefined,
        notice: error instanceof Error ? error.message : String(error),
      });
    } finally {
      patchRow(provider, { busy: false });
    }
  }

  async function submit(event: FormEvent, provider: ProviderId) {
    event.preventDefault();
    const secret = rows[provider].secret.trim();
    if (secret.length === 0) {
      patchRow(provider, { notice: "Paste a value first." });
      return;
    }
    patchRow(provider, { busy: true, notice: null, secret: "" });
    try {
      const session = await postSession(ROUTES.complete, {
        provider,
        tokenOrKey: secret,
      });
      if (session.state === "completed") {
        patchRow(provider, {
          pendingUrl: undefined,
          notice: `Signed in to ${PROVIDER_LABELS[provider]}.`,
        });
      } else {
        patchRow(provider, {
          pendingUrl: undefined,
          notice: session.error ?? "Login failed.",
        });
      }
      void refetch();
    } catch (error) {
      patchRow(provider, {
        notice: error instanceof Error ? error.message : String(error),
      });
    } finally {
      patchRow(provider, { busy: false });
    }
  }

  async function cancel(provider: ProviderId) {
    patchRow(provider, { busy: true });
    try {
      await cancelLogin(provider);
    } catch (error) {
      patchRow(provider, {
        notice: error instanceof Error ? error.message : String(error),
      });
    } finally {
      patchRow(provider, {
        busy: false,
        pendingUrl: undefined,
        secret: "",
      });
    }
  }

  function copyUrl(provider: ProviderId, url: string) {
    navigator.clipboard.writeText(url).then(
      () => {
        patchRow(provider, { copied: true });
        window.setTimeout(
          () => patchRow(provider, { copied: false }),
          1500,
        );
      },
      () => {
        patchRow(provider, { copied: false });
      },
    );
  }

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (loadError !== null && rows.claude.status === null) {
    return (
      <p className="text-sm text-destructive-text">
        Failed to load provider login state: {loadError}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Sign the CLIs on this bb host in without leaving Settings. Tokens and
        keys pass through memory only and are never stored by this plugin.
      </p>
      {PROVIDERS.map((provider) => {
        const row = rows[provider];
        const pending = row.pendingUrl !== undefined;
        const expiry = formatExpiry(row.status?.expiresAt ?? null);
        const details = [
          row.status?.planLabel,
          row.status?.accountEmail,
          expiry === null ? null : `expires ${expiry}`,
        ].filter((part): part is string => part !== null);
        return (
          <section
            key={provider}
            aria-label={`${PROVIDER_LABELS[provider]} login`}
            className="space-y-2.5 rounded-md border border-border px-3 py-3"
          >
            <div className="flex items-center gap-2">
              <StatusDot
                tone={
                  row.status?.loggedIn
                    ? "ok"
                    : pending
                      ? "busy"
                      : "idle"
                }
              />
              <h3 className="text-sm font-semibold">
                {PROVIDER_LABELS[provider]}
              </h3>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {row.status?.loggedIn
                  ? details.length > 0
                    ? `Signed in · ${details.join(" · ")}`
                    : "Signed in"
                  : pending
                    ? "Waiting for you"
                    : "Signed out"}
              </span>
              <span className="flex-1" />
              {!pending ? (
                <button
                  type="button"
                  disabled={row.busy}
                  onClick={() => void start(provider)}
                  className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  {row.status?.loggedIn ? "Re-login" : "Login"}
                </button>
              ) : null}
            </div>
            {pending ? (
              <div className="space-y-2.5">
                {row.pendingUrl ? (
                  <div className="space-y-1.5">
                    <p className="text-sm">
                      Open this link, authorize, then paste the token below.
                    </p>
                    <div className="flex max-w-xl items-center gap-1 rounded-lg border border-border bg-surface-recessed py-1 pl-3.5 pr-1">
                      <a
                        href={row.pendingUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 flex-1 truncate font-mono text-sm text-foreground hover:underline"
                      >
                        {row.pendingUrl}
                      </a>
                      <button
                        type="button"
                        onClick={() => copyUrl(provider, row.pendingUrl ?? "")}
                        className="rounded-md border border-border px-2.5 py-1 text-sm"
                      >
                        {row.copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm">
                    Paste an API key for {PROVIDER_LABELS[provider]} below.
                  </p>
                )}
                <form
                  className="flex max-w-md items-center gap-2"
                  onSubmit={(event) => void submit(event, provider)}
                >
                  <input
                    type="password"
                    value={row.secret}
                    onChange={(event) =>
                      patchRow(provider, { secret: event.target.value })
                    }
                    placeholder={
                      provider === "claude" ? "Setup token" : "API key"
                    }
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={
                      provider === "claude" ? "Setup token" : "API key"
                    }
                    className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 font-mono text-sm"
                  />
                  <button
                    type="submit"
                    disabled={row.busy || row.secret.trim().length === 0}
                    className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    Submit
                  </button>
                  <button
                    type="button"
                    disabled={row.busy}
                    onClick={() => void cancel(provider)}
                    className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </form>
              </div>
            ) : null}
            {row.notice !== null ? (
              <p role="status" className="text-xs text-muted-foreground">
                {row.notice}
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "ai-providers",
    title: "AI providers",
    description: "Sign the Claude and Codex CLIs in from your browser.",
    component: ProviderAuthSettings,
  });
});
