import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { ConnectionManager } from "./views/ConnectionManager";
import { ConnectionEditor } from "./views/ConnectionEditor";
import { Browser } from "./views/Browser";

// Every window loads the same bundle; ?view= picks the screen.
const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "manager";

function App() {
  switch (view) {
    case "editor":
      return <ConnectionEditor id={params.get("id")} newId={params.get("new")} />;
    case "browser":
      return <Browser id={params.get("id") ?? ""} />;
    default:
      return <ConnectionManager />;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
