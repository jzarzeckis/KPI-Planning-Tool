import { serve } from "bun";
import index from "./index.html";
import { handleSignaling } from "./handleSignaling";

const server = serve({
  routes: {
    "/api/signaling": (req) => handleSignaling(req),

    // Serve index.html for all unmatched routes (SPA)
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
