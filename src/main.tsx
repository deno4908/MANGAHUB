import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
// Import theme store to apply saved theme on load
import "./store/themeStore";

createRoot(document.getElementById("root")!).render(<App />);
