import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // Force standalone mode. Without this, Vite loads .env.local and the
    // suite makes live calls to the deployed Worker — slow, flaky, and
    // dependent on someone else's uptime.
    env: { VITE_API_ORIGIN: "" },
  },
});
