import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createManageClient } from "./api";
import { ManageApp } from "./app";
import { followThemePreference } from "./theme";
// oxlint-disable-next-line import/no-unassigned-import -- Bundle the web UI stylesheet.
import "./styles.css";

// The theme is set before the first render, and follows changes made on another page.
followThemePreference();

// Data changes only through this page or a device sync; refetch on focus picks up the latter.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ManageApp client={createManageClient()} path={location.pathname} />
    </QueryClientProvider>
  </StrictMode>,
);
