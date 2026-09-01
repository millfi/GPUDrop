import { createRoot } from "react-dom/client";
import App from "./App";
import { uiLanguage } from "./i18n";

document.documentElement.lang = uiLanguage;

createRoot(document.getElementById("root")!).render(<App />);
