import { useMemo } from "react";
import { ResultDoc, TreeNode } from "../api";
import { Chevron } from "./Icons";

const BADGE: Record<string, string> = {
  ObjectId: "id", String: "Aa", Int32: "#", Int64: "#L", Double: "#.#", Decimal128: "#D",
  Boolean: "T/F", Date: "dt", Object: "{ }", Array: "[ ]", Document: "{ }", Null: "∅",
  Binary: "01", UUID: "uid", Regex: "/./", Timestamp: "ts", Undefined: "?", MinKey: "min", MaxKey: "max",
  JavaScript: "js", Symbol: "sym", DBPointer: "ptr",
};

interface Row {
  path: string;
  depth: number;
  node: TreeNode;
  docIndex: number;
}

interface Props {
  docs: ResultDoc[];
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selectedDoc: number | null;
  onSelectDoc: (index: number) => void;
  onOpenDoc: (index: number) => void;
}

/** Key / Value / Type tree. Every row belongs to one document; clicking any row selects that document. */
export function TreeView({ docs, expanded, onToggle, selectedDoc, onSelectDoc, onOpenDoc }: Props) {
  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (node: TreeNode, path: string, depth: number, docIndex: number) => {
      out.push({ path, depth, node, docIndex });
      if (node.children && expanded.has(path)) {
        node.children.forEach((child, i) => walk(child, `${path}/${i}`, depth + 1, docIndex));
      }
    };
    docs.forEach((d, i) => walk(d.tree, `d${i}`, 0, i));
    return out;
  }, [docs, expanded]);

  return (
    <div className="tree" role="treegrid" aria-label="Documents" aria-multiselectable={false}>
      <div className="grid-head" role="row">
        <span role="columnheader">Key</span>
        <span role="columnheader">Value</span>
        <span role="columnheader">Type</span>
      </div>
      {rows.map(({ path, depth, node, docIndex }) => {
        const isOpen = expanded.has(path);
        const hasKids = !!node.children && node.children.length > 0;
        return (
          <div
            key={path}
            role="row"
            aria-level={depth + 1}
            aria-expanded={hasKids ? isOpen : undefined}
            aria-selected={docIndex === selectedDoc}
            className={`grid-row ${docIndex === selectedDoc ? "selected" : ""}`}
            onClick={() => onSelectDoc(docIndex)}
            onDoubleClick={() => (depth === 0 ? onOpenDoc(docIndex) : hasKids && onToggle(path))}
          >
            <span role="gridcell" className="cell tree-key" style={{ paddingLeft: 8 + depth * 20 }}>
              {hasKids ? (
                <button
                  className={`chev ${isOpen ? "open" : ""}`}
                  aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.key}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(path);
                  }}
                >
                  <Chevron />
                </button>
              ) : (
                <span className="chev-spacer" />
              )}
              <span className="badge" aria-hidden="true">{BADGE[node.typeName] ?? "·"}</span>
              <span className={`label ${depth === 0 ? "doc" : ""}`}>{node.key}</span>
            </span>
            <span role="gridcell" className={`cell v ${node.typeName} selectable`} title={node.value}>
              {node.value}
            </span>
            <span role="gridcell" className="cell type-cell">{node.typeName}</span>
          </div>
        );
      })}
    </div>
  );
}
