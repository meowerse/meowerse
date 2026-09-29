import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { projectSchema } from "./lib/project-schema";

export const collections = {
  projects: defineCollection({ loader: glob({ pattern: "*.json", base: "./src/content/projects" }), schema: projectSchema }),
};
