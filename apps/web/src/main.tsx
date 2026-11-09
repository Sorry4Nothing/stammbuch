import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { AuthProvider } from "./auth/auth";
import { createHttpAuthService } from "./auth/httpAuthService";
import { ThemeProvider } from "./theme/ThemeProvider";
import { ToastProvider } from "./ui";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./styles/motion.css";

const root = document.getElementById("root");
if (!root) throw new Error("Wurzelelement #root fehlt");

const authService = createHttpAuthService();

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider service={authService}>
        <ToastProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
);
