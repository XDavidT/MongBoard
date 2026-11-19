import { useState } from "react";
import { api, errorText } from "../api";
import { Close } from "./Icons";

export type PanelMode =
  | { kind: "add"; text: string }
  | { kind: "edit"; docId: string; text: string; label: string }
  | { kind: "duplicate"; text: string }
  | { kind: "delete"; docId: string; label: string };

interface Props {
  mode: PanelMode;
  /** Production + confirmation enabled: writes need a second click. */
  confirmWrites: boolean;
  namespace: string;
  onClose: () => void;
  onSubmit: (text: string) => Promise<string>;
}

const TITLES = { add: "Add document", edit: "Edit document", duplicate: "Duplicate document", delete: "Delete document?" };

export function DocPanel({ mode, confirmWrites, namespace, onClose, onSubmit }: Props) {
  const [text, setText] = useState(mode.kind === "delete" ? "" : mode.text);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function format() {
    try {
      setText(await api.formatDocument(text));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function submit() {
    if (confirmWrites && !armed) {
      // Validate first so the confirm step isn't wasted on a typo.
      if (mode.kind !== "delete") {
        try {
          await api.formatDocument(text);
        } catch (e) {
          setError(errorText(e));
          return;
        }
      }
      setArmed(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
    } catch (e) {
      setError(errorText(e));
      setArmed(false);
      setBusy(false);
    }
  }

  const actionLabel =
    mode.kind === "delete" ? "Delete document" : mode.kind === "edit" ? "Save" : "Insert";

  return (
    <aside
      aria-label={TITLES[mode.kind]}
      className="col"
      style={{ width: 460, flex: "none", borderLeft: "1px solid var(--border)", background: "var(--panel)", minHeight: 0 }}
    >
      <div className="row" style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <h2 style={{ margin: 0, fontSize: 14, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {TITLES[mode.kind]}
          {"label" in mode && <span className="muted mono" style={{ fontWeight: 400, fontSize: 12 }}> · {mode.label}</span>}
        </h2>
        <button className="btn ghost icon-btn" aria-label="Close panel" onClick={onClose}>
          <Close />
        </button>
      </div>

      {mode.kind === "delete" ? (
        <div className="col" style={{ padding: 14, gap: 12 }}>
          <p style={{ margin: 0, color: "var(--text-2)" }}>
            This permanently removes one document from <strong>{namespace}</strong>:
          </p>
          <pre className="mono selectable" style={{ margin: 0, padding: "10px 12px", borderRadius: 8, background: "var(--input)", border: "1px solid var(--border)", fontSize: 12, whiteSpace: "pre-wrap", color: "var(--warn-text)" }}>
            deleteOne({"{"} _id: {mode.docId} {"}"})
          </pre>
        </div>
      ) : (
        <div className="col" style={{ padding: 14, gap: 10, flex: 1, minHeight: 0 }}>
          <div className="row muted" style={{ fontSize: 11 }}>
            <span>
              {mode.kind === "edit" ? "Replaces the whole document (matched by _id)" : mode.kind === "duplicate" ? "Inserted as a new document with a new _id" : "Inserted as a new document"}
            </span>
            <span className="spacer" />
            <button className="btn" style={{ height: 24 }} onClick={format}>Format</button>
          </div>
          <textarea
            className="textarea"
            aria-label="Document (shell JSON)"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setArmed(false);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                submit();
              }
            }}
            style={{ flex: 1, minHeight: 240 }}
          />
          <span className="muted" style={{ fontSize: 11 }}>
            Shell syntax works: ObjectId("…"), ISODate("…"), NumberLong(…), unquoted keys.
          </span>
        </div>
      )}

      {error && <div className="banner error selectable" style={{ margin: "0 14px 10px" }}>{error}</div>}
      {armed && (
        <div className="banner error" style={{ margin: "0 14px 10px" }}>
          This is a <strong>Production</strong> connection. Click again to confirm.
        </div>
      )}

      <div className="row" style={{ padding: "12px 14px", borderTop: "1px solid var(--border)", justifyContent: "flex-end" }}>
        <button className="btn lg" onClick={onClose}>Cancel</button>
        <button
          className={`btn lg ${mode.kind === "delete" || armed ? "danger-solid" : "primary"}`}
          onClick={submit}
          disabled={busy}
        >
          {busy ? "Working…" : armed ? `Confirm: ${actionLabel}` : `${actionLabel}${mode.kind === "delete" ? "" : " ⌘S"}`}
        </button>
      </div>
    </aside>
  );
}
