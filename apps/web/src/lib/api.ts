// Meow mirrors the api Worker's row shape (workers/api): id, text, slug, created_at.
export interface Meow {
  id: number;
  text: string;
  slug: string;
  created_at: string;
}

export async function listMeows(base: string, token: string): Promise<Meow[]> {
  const res = await fetch(`${base}/api/meows`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return res.json() as Promise<Meow[]>;
}

export async function createMeow(base: string, token: string, text: string): Promise<Meow> {
  const res = await fetch(`${base}/api/meows`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json() as Promise<Meow>;
}
