import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, CollectionInfo, DatabaseInfo, errorText, FindResult, ProfileView, ServerInfo, TAG_LABEL } from "../api";
import { TreeView } from "../components/TreeView";
import { DocPanel, PanelMode } from "../components/DocPanel";
import { Chevron, Collection, Database, Link, Plus, Refresh } from "../components/Icons";

type ViewMode = "tree" | "json";
interface Target {
  db: string;
  collection: string;
}

const NEW_DOC = "{\n  \n}";

function formatBytes(n: number): string {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function Browser({ id }: { id: string }) {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [connError, setConnError] = useState<string | null>(null);

  const [dbs, setDbs] = useState<DatabaseInfo[]>([]);
  const [openDbs, setOpenDbs] = useState<Set<string>>(new Set());
  const [collections, setCollections] = useState<Record<string, CollectionInfo[] | "loading" | { error: string }>>({});
  const [target, setTarget] = useState<Target | null>(null);

  const [filter, setFilter] = useState("{}");
  const [projection, setProjection] = useState("");
  const [sort, setSort] = useState("");
  const [limit, setLimit] = useState(50);
  const [skip, setSkip] = useState(0);

  const [result, setResult] = useState<FindResult | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState<number | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedDoc, setSelectedDoc] = useState<number | null>(null);
  const [panel, setPanel] = useState<PanelMode | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const writable = !!profile && !profile.readOnly;
  const confirmWrites = !!profile && profile.tag === "production" && profile.confirmProdWrites;
  const selected = selectedDoc !== null && result ? result.docs[selectedDoc] ?? null : null;

  // ---------------------------------------------------------------- loading

  const loadDatabases = useCallback(async () => {
    try {
      const list = await api.listDatabases(id);
      setDbs(list);
      setConnError(null);
      return list;
    } catch (e) {
      setConnError(errorText(e));
      return [];
    }
  }, [id]);

  const loadCollections = useCallback(
    async (db: string) => {
      setCollections((c) => ({ ...c, [db]: "loading" }));
      try {
        const list = await api.listCollections(id, db);
        setCollections((c) => ({ ...c, [db]: list }));
      } catch (e) {
        setCollections((c) => ({ ...c, [db]: { error: errorText(e) } }));
      }
    },
    [id],
  );

  useEffect(() => {
    (async () => {
      try {
        const p = await api.getProfile(id);
        setProfile(p);
        getCurrentWindow().setTitle(p.name);
        setServer(await api.connect(id).catch(() => null));
        const list = await loadDatabases();
        const preferred = p.defaultDatabase && list.find((d) => d.name === p.defaultDatabase);
        if (preferred) {
          setOpenDbs(new Set([preferred.name]));
          loadCollections(preferred.name);
        }
      } catch (e) {
        setConnError(errorText(e));
      }
    })();
  }, [id, loadDatabases, loadCollections]);

  const runQuery = useCallback(
    async (t: Target | null = target, nextSkip = skip) => {
      if (!t) return;
      setLoading(true);
      setQueryError(null);
      try {
        const r = await api.find(id, { db: t.db, collection: t.collection, filter, projection, sort, skip: nextSkip, limit });
        setResult(r);
        setSkip(nextSkip);
        setSelectedDoc(r.docs.length ? 0 : null);
        setExpanded(r.docs.length ? new Set(["d0"]) : new Set());
        api.countDocuments(id, t.db, t.collection, filter).then(setTotal, () => setTotal(null));
      } catch (e) {
        setQueryError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [id, target, filter, projection, sort, limit, skip],
  );

  function openCollection(db: string, collection: string) {
    const t = { db, collection };
    setTarget(t);
    setPanel(null);
    setResult(null);
    setTotal(null);
    setFilter("{}");
    setProjection("");
    setSort("");
    setSkip(0);
    // Query with the reset values directly (state updates above apply on the next render).
    setLoading(true);
    setQueryError(null);
    api
      .find(id, { db, collection, filter: "{}", projection: "", sort: "", skip: 0, limit })
      .then((r) => {
        setResult(r);
        setSelectedDoc(r.docs.length ? 0 : null);
        setExpanded(r.docs.length ? new Set(["d0"]) : new Set());
      })
      .catch((e) => setQueryError(errorText(e)))
      .finally(() => setLoading(false));
    api.countDocuments(id, db, collection, "{}").then(setTotal, () => setTotal(null));
  }

  function toggleDb(name: string) {
    setOpenDbs((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else {
        next.add(name);
        if (!collections[name] || typeof collections[name] === "object" && "error" in (collections[name] as object)) loadCollections(name);
      }
      return next;
    });
  }

  // ---------------------------------------------------------------- writes

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 4000);
  }

  async function submitPanel(text: string): Promise<string> {
    if (!target || !panel) return "";
    const { db, collection } = target;
    let message = "";
    if (panel.kind === "add" || panel.kind === "duplicate") {
      const newId = await api.insertDocument(id, db, collection, text);
      message = `Document inserted · _id ${newId}`;
    } else if (panel.kind === "edit") {
      const modified = await api.replaceDocument(id, db, collection, panel.docId, text);
      message = modified ? "Document updated" : "No changes — document is identical";
    } else if (panel.kind === "delete") {
      await api.deleteDocument(id, db, collection, panel.docId);
      message = "Document deleted";
    }
    setPanel(null);
    flash(message);
    await runQuery(target, skip);
    return message;
  }

  const startAdd = () => writable && target && setPanel({ kind: "add", text: NEW_DOC });
  const startEdit = () =>
    writable && selected?.id && setPanel({ kind: "edit", docId: selected.id, text: selected.shell, label: selected.id });
  const startDuplicate = () => writable && selected && setPanel({ kind: "duplicate", text: selected.shellWithoutId });
  const startDelete = () => writable && selected?.id && setPanel({ kind: "delete", docId: selected.id, label: selected.id });

  // Menu bar shortcuts (sent only to the focused window).
  const handlers = useRef({ runQuery, startAdd, startEdit });
  handlers.current = { runQuery, startAdd, startEdit };
  useEffect(() => {
    const un = listen<string>("menu", (e) => {
      const h = handlers.current;
      if (e.payload === "run-query") h.runQuery(undefined, 0);
      if (e.payload === "refresh") h.runQuery();
      if (e.payload === "add-document") h.startAdd();
      if (e.payload === "edit-document") h.startEdit();
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ---------------------------------------------------------------- render

  const queryInput = (label: string, value: string, set: (v: string) => void, flex: string, placeholder = "") => (
    <label className="row input" style={{ flex, height: 32, gap: 10 }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", letterSpacing: "0.04em" }}>{label}</span>
      <input
        className="mono"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") runQuery(undefined, 0);
        }}
        style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", outline: "none", fontSize: 12 }}
      />
    </label>
  );

  const from = result && result.docs.length ? result.skip + 1 : 0;
  const to = result ? result.skip + result.docs.length : 0;

  return (
    <div className="col" style={{ height: "100%" }}>
      {/* Connection bar */}
      <div className="row" style={{ height: 40, padding: "0 14px", borderBottom: "1px solid var(--border)", background: "var(--panel-2)", gap: 10 }}>
        {profile && <span className={`dot ${profile.tag}`} />}
        <strong>{profile?.name ?? "…"}</strong>
        {target && (
          <span className="muted mono" style={{ fontSize: 12 }}>
            › {target.db} › {target.collection}
          </span>
        )}
        <span className="spacer" />
        {server && <span className="muted" style={{ fontSize: 11 }}>MongoDB {server.version} · {server.topology}</span>}
        {profile && profile.tag !== "none" && (
          <span className={`tag ${profile.tag}`}>
            {TAG_LABEL[profile.tag]}
            {profile.readOnly ? " · READ-ONLY" : ""}
          </span>
        )}
        {profile && profile.tag === "none" && profile.readOnly && <span className="tag">READ-ONLY</span>}
        <button className="btn" onClick={() => api.openConnectionManager()}>
          <Link /> Connect…
        </button>
      </div>

      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: "stretch", gap: 0 }}>
        {/* Sidebar */}
        <nav aria-label="Databases" style={{ width: 260, flex: "none", overflow: "auto", borderRight: "1px solid var(--border)", background: "var(--panel)", padding: "10px 8px" }}>
          <div className="row" style={{ padding: "2px 8px 8px" }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--muted)" }}>Databases</span>
            <span className="spacer" />
            <button className="btn ghost icon-btn" style={{ height: 22 }} aria-label="Refresh databases" onClick={loadDatabases}>
              <Refresh />
            </button>
          </div>
          {connError && (
            <div className="banner error selectable" style={{ margin: "4px 4px 8px" }}>
              {connError}
              <div style={{ marginTop: 8 }}>
                <button className="btn" onClick={async () => {
                  try {
                    setServer(await api.connect(id));
                    await loadDatabases();
                  } catch (e) {
                    setConnError(errorText(e));
                  }
                }}>Reconnect</button>
              </div>
            </div>
          )}
          {dbs.map((d) => {
            const open = openDbs.has(d.name);
            const cols = collections[d.name];
            return (
              <div key={d.name}>
                <button className="row sidebar-item" onClick={() => toggleDb(d.name)} aria-expanded={open} style={sideItem(false, 0)}>
                  <span className={`chev ${open ? "open" : ""}`} aria-hidden="true"><Chevron /></span>
                  <Database />
                  <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</span>
                  <span className="muted" style={{ fontSize: 10.5 }}>{formatBytes(d.sizeOnDisk)}</span>
                </button>
                {open && cols === "loading" && <div className="muted" style={{ padding: "4px 44px", fontSize: 12 }}>Loading…</div>}
                {open && cols && typeof cols === "object" && "error" in cols && (
                  <div className="banner error" style={{ margin: "4px 8px 4px 28px" }}>{cols.error}</div>
                )}
                {open && Array.isArray(cols) && cols.length === 0 && <div className="muted" style={{ padding: "4px 44px", fontSize: 12 }}>No collections</div>}
                {open && Array.isArray(cols) &&
                  cols.map((c) => {
                    const active = target?.db === d.name && target.collection === c.name;
                    return (
                      <button key={c.name} className="row" onClick={() => openCollection(d.name, c.name)} aria-current={active} style={sideItem(active, 1)}>
                        <Collection size={13} />
                        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                        {c.kind !== "collection" && <span className="muted" style={{ fontSize: 10.5 }}>{c.kind}</span>}
                      </button>
                    );
                  })}
              </div>
            );
          })}
        </nav>

        {/* Main area */}
        <main className="col" style={{ flex: 1, minWidth: 0 }}>
          {!target ? (
            <div className="empty" style={{ margin: "auto" }}>Pick a collection on the left to browse its documents.</div>
          ) : (
            <>
              <div className="col" style={{ padding: "12px 16px", gap: 8, borderBottom: "1px solid var(--border)" }}>
                <div className="row">
                  {queryInput("FILTER", filter, setFilter, "1 1 420px", "{ status: \"active\" }")}
                  <button className="btn primary" style={{ height: 32 }} onClick={() => runQuery(undefined, 0)} disabled={loading}>
                    {loading ? "Running…" : "Run ⌘↵"}
                  </button>
                </div>
                <div className="row">
                  {queryInput("PROJECT", projection, setProjection, "2 1 220px", "{ name: 1 }")}
                  {queryInput("SORT", sort, setSort, "1 1 160px", "{ _id: -1 }")}
                  <label className="row input" style={{ flex: "0 0 130px", height: 32, gap: 8 }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)" }}>LIMIT</span>
                    <select aria-label="Limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ flex: 1, border: 0, background: "transparent", outline: "none" }}>
                      {[20, 50, 100, 200, 500, 1000].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                </div>
              </div>

              <div className="toolbar" style={{ padding: "8px 16px" }}>
                <div role="group" aria-label="Result view" className="row" style={{ padding: 2, gap: 0, borderRadius: 7, background: "var(--hover)", border: "1px solid var(--border)" }}>
                  {(["tree", "json"] as ViewMode[]).map((m) => (
                    <button
                      key={m}
                      aria-pressed={viewMode === m}
                      onClick={() => setViewMode(m)}
                      style={{ height: 24, padding: "0 12px", border: 0, borderRadius: 5, fontSize: 12, background: viewMode === m ? "var(--accent)" : "transparent", color: viewMode === m ? "var(--accent-text)" : "var(--text-2)", fontWeight: viewMode === m ? 600 : 400 }}
                    >
                      {m === "tree" ? "Tree" : "JSON"}
                    </button>
                  ))}
                </div>
                <button className="btn ghost icon-btn" aria-label="Previous page" disabled={!result || result.skip === 0 || loading} onClick={() => runQuery(undefined, Math.max(0, skip - limit))}>‹</button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {result ? `${from}–${to}${total !== null ? ` of ${total.toLocaleString()}` : ""}` : ""}
                </span>
                <button className="btn ghost icon-btn" aria-label="Next page" disabled={!result || !result.hasMore || loading} onClick={() => runQuery(undefined, skip + limit)}>›</button>
                {result && <span className="muted" style={{ fontSize: 12 }}>· {result.elapsedMs} ms</span>}
                <span className="spacer" />
                <div role="toolbar" aria-label="Document actions" className="row" style={{ gap: 6 }}>
                  <button className="btn primary" onClick={startAdd} disabled={!writable} title={writable ? "" : "Read-only connection"}>
                    <Plus /> Add document
                  </button>
                  <button className="btn" onClick={startEdit} disabled={!writable || !selected?.id}>Edit</button>
                  <button className="btn" onClick={startDuplicate} disabled={!writable || !selected}>Duplicate</button>
                  <button className="btn danger" onClick={startDelete} disabled={!writable || !selected?.id}>Delete</button>
                </div>
              </div>

              <div className="row" style={{ flex: 1, minHeight: 0, alignItems: "stretch", gap: 0 }}>
                <div className="col" style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ flex: 1, overflow: "auto" }}>
                    {queryError && <div className="banner error selectable" style={{ margin: 16 }}>{queryError}</div>}
                    {result && result.docs.length === 0 && !queryError && <div className="empty">No documents match this filter.</div>}
                    {result && result.docs.length > 0 && viewMode === "tree" && (
                      <TreeView
                        docs={result.docs}
                        expanded={expanded}
                        onToggle={(path) =>
                          setExpanded((s) => {
                            const next = new Set(s);
                            if (next.has(path)) next.delete(path);
                            else next.add(path);
                            return next;
                          })
                        }
                        selectedDoc={selectedDoc}
                        onSelectDoc={setSelectedDoc}
                        onOpenDoc={(i) => {
                          setSelectedDoc(i);
                          const d = result.docs[i];
                          if (writable && d.id) setPanel({ kind: "edit", docId: d.id, text: d.shell, label: d.id });
                        }}
                      />
                    )}
                    {result && result.docs.length > 0 && viewMode === "json" && (
                      <div className="col" style={{ padding: 12, gap: 8 }}>
                        {result.docs.map((d, i) => (
                          <pre
                            key={i}
                            onClick={() => setSelectedDoc(i)}
                            className="mono selectable"
                            style={{ margin: 0, padding: 12, borderRadius: 8, fontSize: 12, lineHeight: 1.6, background: "var(--input)", border: `1px solid ${i === selectedDoc ? "var(--accent)" : "var(--border)"}`, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                          >
                            {d.shell}
                          </pre>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="statusbar">
                    <span>{selected ? "1 document selected" : "No document selected"}</span>
                    {toast && <span role="status" style={{ color: "var(--accent-strong)" }}>{toast}</span>}
                    <span className="spacer" />
                    {!writable && profile && <span>Read-only connection</span>}
                  </div>
                </div>
                {panel && target && (
                  <DocPanel
                    key={JSON.stringify(panel)}
                    mode={panel}
                    confirmWrites={confirmWrites}
                    namespace={`${target.db}.${target.collection}`}
                    onClose={() => setPanel(null)}
                    onSubmit={submitPanel}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function sideItem(active: boolean, depth: number): CSSProperties {
  return {
    width: "100%",
    height: 28,
    gap: 6,
    padding: `0 8px 0 ${8 + depth * 22}px`,
    border: 0,
    borderRadius: 6,
    fontSize: 13,
    background: active ? "var(--accent-soft)" : "transparent",
    color: active ? "var(--text)" : "var(--text-2)",
    fontWeight: active ? 600 : 400,
  };
}
