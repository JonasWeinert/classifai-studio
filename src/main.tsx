import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppProvider } from "./lib/app";
import { initPersist } from "./lib/persist";
import "./index.css";

// Saved UI state (last page, theme, drafts) comes from the database before the first render.
initPersist().then(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </React.StrictMode>,
  ),
);
