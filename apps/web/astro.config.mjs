import { defineConfig } from "astro/config";

// No framework integrations: the homepage is a small vanilla-JS island, so we no
// longer ship react/react-dom to the client.
export default defineConfig({});
