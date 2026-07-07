import type { DbClient, Row } from "./types";

/**
 * Adapt Cloudflare's D1Database to our structural DbClient (so handlers depend
 * on a tiny interface a fake can satisfy). D1 reads are served from free,
 * automatic regional read replicas; writes go to the primary.
 */
export function d1Client(db: D1Database): DbClient {
  const stmt = (sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params);
  return {
    async all(sql, params = []) {
      const res = await stmt(sql, params).all<Row>();
      return res.results ?? [];
    },
    async first(sql, params = []) {
      return (await stmt(sql, params).first<Row>()) ?? undefined;
    },
    async run(sql, params = []) {
      await stmt(sql, params).run();
    },
  };
}
