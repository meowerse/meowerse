import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSchema, publicFactProblems, type Project } from "./project-schema";

const dir = join(__dirname, "../content/projects");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Project;

describe("project content (B11, B13)", () => {
  it("has exactly the six decided projects", () =>
    expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual(["alxnko-dev", "auth", "meowsenger", "moonmeow", "sunmeow", "ui"]));
  it.each(files)("%s matches the schema", (f) => {
    const r = projectSchema.safeParse(load(f));
    expect(r.success ? [] : r.error.issues).toEqual([]);
  });
  it("orders are 1..6 without gaps, and only auth and meowsenger are live services", () => {
    expect(files.map((f) => load(f).order).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(files.filter((f) => load(f).service).map((f) => f.replace(/\.json$/, "")).sort()).toEqual(["auth", "meowsenger"]);
  });
  it.each(files)("%s states public facts only", (f) => expect(publicFactProblems(f.replace(/\.json$/, ""), load(f))).toEqual([]));
  it("the guard catches network details anywhere and a real name on the alxnko.dev page", () => {
    const base = load("moonmeow.json");
    expect(publicFactProblems("moonmeow", { ...base, how: ["Streams over Tailscale to 100.64.0.1 after pairing."] })).toHaveLength(3);
    expect(publicFactProblems("alxnko-dev", { ...load("alxnko-dev.json"), what: ["Made by Alex Neko, tech lead."] })).toHaveLength(2);
  });
});
