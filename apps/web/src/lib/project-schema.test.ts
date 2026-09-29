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
  it("the guard catches the real surname in Cyrillic on the alxnko.dev page", () => {
    const base = load("alxnko-dev.json");
    expect(publicFactProblems("alxnko-dev", { ...base, what: ["Сделано под псевдонимом, но это Нырко."] })).toHaveLength(1);
  });
  it("the guard catches the real first name in Cyrillic on the alxnko.dev page", () => {
    const base = load("alxnko-dev.json");
    expect(publicFactProblems("alxnko-dev", { ...base, what: ["Александр — тот, кто это сделал."] })).toHaveLength(1);
  });
  it("the guard catches the real first name in Latin — 'Alexander' and 'Aleksandr'", () => {
    const base = load("alxnko-dev.json");
    expect(publicFactProblems("alxnko-dev", { ...base, what: ["Built by Alexander in his spare time."] })).toHaveLength(1);
    expect(publicFactProblems("alxnko-dev", { ...base, what: ["Built by Aleksandr in his spare time."] })).toHaveLength(1);
  });
  it("the real-name guard applies to every project page, not only alxnko-dev", () => {
    for (const f of files) {
      const slug = f.replace(/\.json$/, "");
      const base = load(f);
      // "tech lead"/"company"/etc. never appear, so exactly the one real-name pattern (/neko|nyrko/i)
      // fires — on every page, including ones the employer-only rules don't reach.
      expect(publicFactProblems(slug, { ...base, summary: "Built by Alex Neko in his spare time." })).toHaveLength(1);
    }
  });
  it("the employer/company framing is barred only on alxnko-dev, not on every page", () => {
    expect(publicFactProblems("alxnko-dev", { ...load("alxnko-dev.json"), summary: "Built at a company." })).toHaveLength(1);
    expect(publicFactProblems("moonmeow", { ...load("moonmeow.json"), summary: "Built at a company." })).toEqual([]);
  });
});
