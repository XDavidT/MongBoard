import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorText, ProfileView, relativeTime, TAG_LABEL, EnvTag } from "../api";
import { Plus, Search } from "../components/Icons";

const GROUPS: { label: string; tags: EnvTag[] }[] = [
  { label: "Production", tags: ["production"] },
  { label: "Non-production", tags: ["qa", "dev"] },
  { label: "Local", tags: ["local"] },
  { label: "Other", tags: ["none"] },
];

const COLS = "minmax(0,3fr) 70px minmax(0,4fr) minmax(0,2fr) minmax(0,1.5fr)";

function authLabel(p: ProfileView): string {
  const base = p.auth === "password" ? "Password" : p.auth === "aws" ? "AWS IAM" : "None";
  return p.readOnly ? `${base} · read-only` : base;
}

export function ConnectionManager() {
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(async () => {
    try {
      setProfiles(await api.listProfiles());
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    reload();
    const un = listen("profiles-changed", reload);
    return () => {
      un.then((f) => f());
    };
  }, [reload]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? profiles.filter((p) => `${p.name} ${p.uri}`.toLowerCase().includes(q)) : profiles;
  }, [profiles, filter]);

  const current = profiles.find((p) => p.id === selected) ?? null;

  async function connect(id = selected) {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await api.openConnection(id);
      await getCurrentWindow().close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="col" style={{ height: "100%" }}>
      <div className="toolbar" role="toolbar" aria-label="Connection actions">
        <button className="btn primary" onClick={() => run(() => api.openConnectionEditor(null))}>
          <Plus /> New connection
        </button>
        <button className="btn" disabled={!current} onClick={() => current && run(() => api.openConnectionEditor(current.id))}>
          Edit
        </button>
        <button className="btn" disabled={!current} onClick={() => current && run(() => api.duplicateProfile(current.id))}>
          Duplicate
        </button>
        <button className="btn danger" disabled={!current} onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
        <span className="spacer" />
        <label className="row input" style={{ height: 30, width: 240, gap: 8, color: "var(--muted)" }}>
          <Search />
          <input
            type="search"
            placeholder="Filter connections"
            aria-label="Filter connections"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", outline: "none", fontSize: 12 }}
          />
        </label>
      </div>

      {confirmDelete && current && (
        <div className="row banner error" style={{ margin: "10px 14px 0" }}>
          <span>
            Delete <strong>{current.name}</strong>? Its saved password is removed from the Keychain too.
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button
            className="btn danger-solid"
            onClick={() =>
              run(async () => {
                await api.deleteProfile(current.id);
                setSelected(null);
                setConfirmDelete(false);
              })
            }
          >
            Delete
          </button>
        </div>
      )}
      {error && <div className="banner error" style={{ margin: "10px 14px 0" }}>{error}</div>}

      <div role="grid" aria-label="Saved connections" style={{ flex: 1, overflow: "auto" }}>
        <div className="grid-head" role="row" style={{ gridTemplateColumns: COLS }}>
          <span role="columnheader" style={{ paddingLeft: 16 }}>Name</span>
          <span role="columnheader">Tag</span>
          <span role="columnheader">Server</span>
          <span role="columnheader">Auth</span>
          <span role="columnheader">Last used</span>
        </div>
        {profiles.length === 0 && (
          <div className="empty">
            No saved connections yet.
            <div style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => run(() => api.openConnectionEditor(null))}>
                <Plus /> New connection
              </button>
            </div>
          </div>
        )}
        {GROUPS.map((g) => {
          const rows = visible.filter((p) => g.tags.includes(p.tag));
          if (rows.length === 0) return null;
          return (
            <div key={g.label} role="rowgroup">
              <div className="group-label">{g.label}</div>
              {rows.map((p) => (
                <div
                  key={p.id}
                  role="row"
                  aria-selected={p.id === selected}
                  className={`grid-row ${p.id === selected ? "selected" : ""}`}
                  style={{ gridTemplateColumns: COLS, minHeight: 38 }}
                  onClick={() => setSelected(p.id)}
                  onDoubleClick={() => connect(p.id)}
                >
                  <span role="gridcell" className="cell" style={{ gap: 10, paddingLeft: 16 }}>
                    <span className={`dot ${p.tag}`} />
                    <button
                      className="btn ghost"
                      style={{ padding: 0, height: "auto", fontSize: 13, fontWeight: 600 }}
                      onClick={() => setSelected(p.id)}
                    >
                      {p.name}
                    </button>
                  </span>
                  <span role="gridcell" className="cell">
                    {p.tag !== "none" && <span className={`tag ${p.tag}`}>{TAG_LABEL[p.tag]}</span>}
                  </span>
                  <span role="gridcell" className="cell mono" style={{ fontSize: 12, color: "var(--text-2)" }}>{p.uri}</span>
                  <span role="gridcell" className="cell" style={{ fontSize: 12, color: "var(--text-2)" }}>{authLabel(p)}</span>
                  <span role="gridcell" className="cell muted" style={{ fontSize: 12 }}>{relativeTime(p.lastUsed)}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="statusbar" style={{ padding: "12px 16px" }}>
        <span>
          {current ? `${current.name} selected` : "No connection selected"} · {profiles.length} connection
          {profiles.length === 1 ? "" : "s"} · passwords stored in the Keychain
        </span>
        <span className="spacer" />
        <button className="btn lg" onClick={() => getCurrentWindow().close()}>Close</button>
        <button className="btn lg primary" disabled={!current || busy} onClick={() => connect()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </div>
  );
}
