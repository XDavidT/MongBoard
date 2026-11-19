import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorText, newProfile, Profile, ServerInfo, AuthKind, EnvTag } from "../api";
import { Check } from "../components/Icons";

type Tab = "server" | "auth" | "safety";

export function ConnectionEditor({ id, newId }: { id: string | null; newId: string | null }) {
  const isNew = !id;
  const [profile, setProfile] = useState<Profile>(() => newProfile(newId ?? crypto.randomUUID()));
  const [hasPassword, setHasPassword] = useState(false);
  // null = leave the stored password unchanged
  const [password, setPassword] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("server");
  const [loaded, setLoaded] = useState(isNew);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: true; info: ServerInfo } | { ok: false; error: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .getProfile(id)
      .then((p) => {
        setProfile(p);
        setHasPassword(p.hasPassword);
        setLoaded(true);
        getCurrentWindow().setTitle(`Edit connection — ${p.name}`);
      })
      .catch((e) => setResult({ ok: false, error: errorText(e) }));
  }, [id]);

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setProfile((p) => ({ ...p, [key]: value }));

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult({ ok: true, info: await api.testConnection(profile, password) });
    } catch (e) {
      setResult({ ok: false, error: errorText(e) });
    } finally {
      setTesting(false);
    }
  }

  async function save(andConnect: boolean) {
    setSaving(true);
    setResult(null);
    try {
      const saved = await api.saveProfile(profile, password);
      if (andConnect) await api.openConnection(saved.id);
      await getCurrentWindow().close();
    } catch (e) {
      setResult({ ok: false, error: errorText(e) });
      setSaving(false);
    }
  }

  if (!loaded) return <div className="empty">{result && !result.ok ? result.error : "Loading…"}</div>;

  const tabs: [Tab, string][] = [
    ["server", "Server"],
    ["auth", "Authentication"],
    ["safety", "Safety"],
  ];

  return (
    <form
      className="col"
      style={{ height: "100%" }}
      onSubmit={(e) => {
        e.preventDefault();
        save(true);
      }}
    >
      <div className="col" style={{ padding: "22px 28px 0", gap: 16 }}>
        <div className="row" style={{ gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 20 }}>{profile.name || (isNew ? "New connection" : "Untitled")}</h1>
          {profile.tag !== "none" && <span className={`tag ${profile.tag}`}>{profile.tag.toUpperCase()}</span>}
          {profile.readOnly && <span className="tag">Read-only</span>}
        </div>
        <div role="tablist" className="row" style={{ gap: 2, borderBottom: "1px solid var(--border)" }}>
          {tabs.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              style={{
                height: 34, padding: "0 14px", border: 0, background: "transparent",
                borderBottom: `2px solid ${tab === key ? "var(--accent)" : "transparent"}`,
                color: tab === key ? "var(--text)" : "var(--muted)", fontWeight: tab === key ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="col" style={{ flex: 1, overflow: "auto", padding: "20px 28px", gap: 18 }}>
        {tab === "server" && (
          <>
            <label className="field">
              Connection string
              <input
                className="input mono"
                value={profile.uri}
                onChange={(e) => set("uri", e.target.value)}
                placeholder="mongodb+srv://cluster0.example.mongodb.net/"
                spellCheck={false}
                autoFocus
              />
              <span className="muted" style={{ fontWeight: 400 }}>
                If you paste a string with user:password, they're moved to the Authentication tab and the password goes to the Keychain.
              </span>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
              <label className="field">
                Display name
                <input className="input" value={profile.name} onChange={(e) => set("name", e.target.value)} placeholder="prod-us-east" />
              </label>
              <label className="field">
                Environment tag
                <select className="select" value={profile.tag} onChange={(e) => set("tag", e.target.value as EnvTag)}>
                  <option value="none">None</option>
                  <option value="production">Production</option>
                  <option value="qa">QA</option>
                  <option value="dev">Development</option>
                  <option value="local">Local</option>
                </select>
              </label>
              <label className="field">
                Default database (optional)
                <input className="input" value={profile.defaultDatabase ?? ""} onChange={(e) => set("defaultDatabase", e.target.value)} />
              </label>
            </div>
          </>
        )}

        {tab === "auth" && (
          <>
            <label className="field" style={{ maxWidth: 320 }}>
              Method
              <select className="select" value={profile.auth} onChange={(e) => set("auth", e.target.value as AuthKind)}>
                <option value="none">None / from connection string</option>
                <option value="password">Username and password</option>
                <option value="aws">AWS IAM</option>
              </select>
            </label>
            {profile.auth === "password" && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
                <label className="field">
                  Username
                  <input className="input" value={profile.username ?? ""} onChange={(e) => set("username", e.target.value)} autoComplete="off" />
                </label>
                <label className="field">
                  <span>
                    Password {hasPassword && password === null && <span className="muted" style={{ fontWeight: 400 }}>· saved in Keychain</span>}
                  </span>
                  <input
                    className="input"
                    type="password"
                    value={password ?? ""}
                    placeholder={hasPassword ? "•••••••• (unchanged)" : ""}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="field">
                  Auth database (authSource)
                  <input className="input" value={profile.authSource ?? ""} onChange={(e) => set("authSource", e.target.value)} placeholder="admin" />
                </label>
                <label className="field">
                  Mechanism
                  <select className="select" value={profile.authMechanism ?? ""} onChange={(e) => set("authMechanism", e.target.value)}>
                    <option value="">Default (negotiate)</option>
                    <option value="SCRAM-SHA-256">SCRAM-SHA-256</option>
                    <option value="SCRAM-SHA-1">SCRAM-SHA-1</option>
                  </select>
                </label>
              </div>
            )}
            {profile.auth === "aws" && (
              <div className="col" style={{ gap: 12 }}>
                <label className="field" style={{ maxWidth: 360 }}>
                  AWS profile (optional)
                  <input className="input" value={profile.awsProfile ?? ""} onChange={(e) => set("awsProfile", e.target.value)} placeholder="default credential chain" />
                </label>
                <p className="muted" style={{ margin: 0, maxWidth: 560, lineHeight: 1.5 }}>
                  Leave empty to use the standard AWS credential chain (environment variables, ~/.aws files, SSO, or an attached IAM role).
                  Or enter a profile name from ~/.aws/config. The IAM role must be added as a database user on the cluster ($external).
                </p>
              </div>
            )}
          </>
        )}

        {tab === "safety" && (
          <div className="col" style={{ gap: 12, padding: 16, borderRadius: 10, background: "var(--panel)", border: "1px solid var(--border)" }}>
            <label className="check">
              <input type="checkbox" checked={profile.readOnly} onChange={(e) => set("readOnly", e.target.checked)} />
              Read-only — block insert, update and delete for this connection
            </label>
            <label className="check">
              <input type="checkbox" checked={profile.confirmProdWrites} onChange={(e) => set("confirmProdWrites", e.target.checked)} />
              Ask for confirmation before any write when tagged Production
            </label>
          </div>
        )}

        {result && (
          <div className={`banner ${result.ok ? "ok" : "error"} row selectable`}>
            {result.ok ? (
              <>
                <Check /> Connected · {result.info.topology} · MongoDB {result.info.version} · {result.info.latencyMs} ms
              </>
            ) : (
              result.error
            )}
          </div>
        )}
      </div>

      <div className="statusbar" style={{ padding: "12px 20px" }}>
        <button type="button" className="btn lg" onClick={test} disabled={testing || saving}>
          {testing ? "Testing…" : "Test"}
        </button>
        <span className="spacer" />
        <button type="button" className="btn lg" onClick={() => getCurrentWindow().close()}>Cancel</button>
        <button type="button" className="btn lg" onClick={() => save(false)} disabled={saving}>Save</button>
        <button type="submit" className="btn lg primary" disabled={saving}>
          {saving ? "Saving…" : "Save & connect"}
        </button>
      </div>
    </form>
  );
}
