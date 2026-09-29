// Each demo's own source, shown under it (Vite ?raw): the code on the page is the code that runs.
const raw = import.meta.glob<string>("./demos/*.tsx", { query: "?raw", import: "default", eager: true });

export const DEMO_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(raw).map(([path, src]) => [path.replace(/^\.\/demos\//, "").replace(/\.tsx$/, ""), src]),
);
export const DEMO_SLUGS: string[] = Object.keys(DEMO_SOURCES).sort();
