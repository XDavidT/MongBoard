import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { ConnectionManager } from "./views/ConnectionManager";
import { ConnectionEditor } from "./views/ConnectionEditor";
import { MainWindow } from "./views/MainWindow";

// Every window loads the same bundle; ?view= picks the screen.
const params = new URLSearchParams(window.location.search);
const view = import.meta.env.VITE_DEMO_VIEW || (params.get("view") ?? "main");
if (import.meta.env.VITE_DEMO_VIEW) params.set("id", "p3");

function App() {
  switch (view) {
    case "editor":
      return <ConnectionEditor id={params.get("id")} newId={params.get("new")} />;
    case "manager":
      return <ConnectionManager />;
    default:
      return <MainWindow />;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
