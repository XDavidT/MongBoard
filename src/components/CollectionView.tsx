import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, FindResult, ProfileView } from "../api";
import { TreeView } from "./TreeView";
import { DocPanel, PanelMode } from "./DocPanel";
import { Plus } from "./Icons";

type ViewMode = "tree" | "json";
const NEW_DOC = "{\n  \n}";

interface Props {
  profile: ProfileView;
  db: string;
  collection: string;
  /** Only the visible tab reacts to menu shortcuts. */
  active: boolean;
}

/** One collection tab: query bar, results (tree / JSON) and the document panel. */
export function CollectionView({ profile, db, collection, active }: Props) {
  const id = profile.id;
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

  const writable = !profile.readOnly;
  const confirmWrites = profile.tag === "production" && profile.confirmProdWrites;
  const selected = selectedDoc !== null && result ? (result.docs[selectedDoc] ?? null) : null;

  const runQuery = useCallback(
    async (nextSkip: number, keepSelection = false) => {
      setLoading(true);
      setQueryError(null);
      try {
        const r = await api.find(id, { db, collection, filter, projection, sort, skip: nextSkip, limit });
        setResult(r);
        setSkip(nextSkip);
        if (!keepSelection) {
          setSelectedDoc(r.docs.length ? 0 : null);
          setExpanded(r.docs.length ? new Set(["d0"]) : new Set());
        } else {
          setSelectedDoc((s) => (s !== null && s < r.docs.length ? s : r.docs.length ? 0 : null));
        }
        api.countDocuments(id, db, collection, filter).then(setTotal, () => setTotal(null));
      } catch (e) {
        setQueryError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [id, db, collection, filter, projection, sort, limit],
  );

  // First load when the tab opens.
  const loaded = useRef(false);
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      runQuery(0);
    }
  }, [runQuery]);

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 4000);
  }

  async function submitPanel(text: string): Promise<string> {
    if (!panel) return "";
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
    await runQuery(skip, panel.kind === "edit");
    return message;
  }

  const startAdd = () => writable && setPanel({ kind: "add", text: NEW_DOC });
  const startEdit = () =>
    writable && selected?.id && setPanel({ kind: "edit", docId: selected.id, text: selected.shell, label: selected.id });
  const startDuplicate = () => writable && selected && setPanel({ kind: "duplicate", text: selected.shellWithoutId });
  const startDelete = () => writable && selected?.id && setPanel({ kind: "delete", docId: selected.id, label: selected.id });

  // Menu bar shortcuts, for the visible tab only.
  const handlers = useRef({ runQuery, startAdd, startEdit, skip });
  handlers.current = { runQuery, startAdd, startEdit, skip };
  useEffect(() => {
    if (!active) return;
    const un = listen<string>("menu", (e) => {
      const h = handlers.current;
      if (e.payload === "run-query") h.runQuery(0);
      if (e.payload === "refresh") h.runQuery(h.skip, true);
      if (e.payload === "add-document") h.startAdd();
      if (e.payload === "edit-document") h.startEdit();
    });
    return () => {
      un.then((f) => f());
    };
  }, [active]);

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
          if (e.key === "Enter") runQuery(0);
        }}
        style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", outline: "none", fontSize: 12 }}
      />
    </label>
  );

  const from = result && result.docs.length ? result.skip + 1 : 0;
  const to = result ? result.skip + result.docs.length : 0;

  return (
    <div className="col" style={{ flex: 1, minHeight: 0 }}>
      <div className="col" style={{ padding: "12px 16px", gap: 8, borderBottom: "1px solid var(--border)" }}>
        <div className="row">
          {queryInput("FILTER", filter, setFilter, "1 1 420px", '{ status: "active" }')}
          <button className="btn primary" style={{ height: 32 }} onClick={() => runQuery(0)} disabled={loading}>
            {loading ? "Running…" : "Run ⌘↵"}
          </button>
        </div>
        <div className="row">
          {queryInput("PROJECT", projection, setProjection, "2 1 220px", "{ name: 1 }")}
          {queryInput("SORT", sort, setSort, "1 1 160px", "{ _id: -1 }")}
          <label className="row input" style={{ flex: "0 0 130px", height: 32, gap: 8 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)" }}>LIMIT</span>
            <select
              aria-label="Limit"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              style={{ flex: 1, border: 0, background: "transparent", outline: "none" }}
            >
              {[20, 50, 100, 200, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="toolbar" style={{ padding: "8px 16px" }}>
        <div
          role="group"
          aria-label="Result view"
          className="row"
          style={{ padding: 2, gap: 0, borderRadius: 7, background: "var(--hover)", border: "1px solid var(--border)" }}
        >
          {(["tree", "json"] as ViewMode[]).map((m) => (
            <button
              key={m}
              aria-pressed={viewMode === m}
              onClick={() => setViewMode(m)}
              className={`seg ${viewMode === m ? "on" : ""}`}
            >
              {m === "tree" ? "Tree" : "JSON"}
            </button>
          ))}
        </div>
        <button
          className="btn ghost icon-btn"
          aria-label="Previous page"
          disabled={!result || result.skip === 0 || loading}
          onClick={() => runQuery(Math.max(0, skip - limit))}
        >
          ‹
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {result ? `${from}–${to}${total !== null ? ` of ${total.toLocaleString()}` : ""}` : ""}
        </span>
        <button
          className="btn ghost icon-btn"
          aria-label="Next page"
          disabled={!result || !result.hasMore || loading}
          onClick={() => runQuery(skip + limit)}
        >
          ›
        </button>
        {result && <span className="muted" style={{ fontSize: 12 }}>· {result.elapsedMs} ms</span>}
        <span className="spacer" />
        <div role="toolbar" aria-label="Document actions" className="row" style={{ gap: 6 }}>
          <button className="btn primary" onClick={startAdd} disabled={!writable} title={writable ? "" : "Read-only connection"}>
            <Plus /> Add document
          </button>
          <button className="btn" onClick={startEdit} disabled={!writable || !selected?.id}>
            Edit
          </button>
          <button className="btn" onClick={startDuplicate} disabled={!writable || !selected}>
            Duplicate
          </button>
          <button className="btn danger" onClick={startDelete} disabled={!writable || !selected?.id}>
            Delete
          </button>
        </div>
      </div>

      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: "stretch", gap: 0 }}>
        <div className="col" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ flex: 1, overflow: "auto" }}>
            {queryError && (
              <div className="banner error selectable" style={{ margin: 16 }}>
                {queryError}
              </div>
            )}
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
                    className="mono selectable json-doc"
                    style={{ borderColor: i === selectedDoc ? "var(--accent)" : "var(--border)" }}
                  >
                    {d.shell}
                  </pre>
                ))}
              </div>
            )}
          </div>
          <div className="statusbar">
            <span>{selected ? "1 document selected" : "No document selected"}</span>
            {toast && (
              <span role="status" style={{ color: "var(--accent-strong)" }}>
                {toast}
              </span>
            )}
            <span className="spacer" />
            {!writable && <span>Read-only connection</span>}
          </div>
        </div>
        {panel && (
          <DocPanel
            key={JSON.stringify(panel)}
            mode={panel}
            confirmWrites={confirmWrites}
            namespace={`${db}.${collection}`}
            onClose={() => setPanel(null)}
            onSubmit={submitPanel}
          />
        )}
      </div>
    </div>
  );
}
