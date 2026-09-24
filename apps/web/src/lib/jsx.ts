// Usage snippets serialised from the very React elements the docs previews render, so a snippet can't
// disagree with what's on screen (spec §5.2).
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";

type Part = string | number | ReactElement;

const nameOf = (type: unknown): string => {
  if (typeof type === "string") return type;
  if (type === Fragment) return "";
  const t = type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string } };
  return t.displayName || t.render?.displayName || t.render?.name || t.name || "Component"; // "" is anonymous
};

const flat = (c: ReactNode): Part[] =>
  Array.isArray(c) ? c.flatMap(flat)
    : isValidElement(c) ? [c]
      : typeof c === "string" || typeof c === "number" ? [c]
        : [];

const text = (s: string) => (/[{}<>]/.test(s) ? `{${JSON.stringify(s)}}` : s);
const handler = (prop: string) => (/^on[A-Z]/.test(prop) ? `handle${prop.slice(2)}` : prop);

function attr(k: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (v === true) return k;
  if (typeof v === "string") return /["\n]/.test(v) ? `${k}={${JSON.stringify(v)}}` : `${k}="${v}"`;
  if (typeof v === "number" || typeof v === "boolean") return `${k}={${v}}`;
  if (typeof v === "function") return `${k}={${handler(k)}}`;
  if (isValidElement(v)) return `${k}={${toJsx(v).replace(/\n\s*/g, "")}}`;
  return `${k}={${JSON.stringify(v)}}`;
}

export function toJsx(node: ReactNode, indent = ""): string {
  if (!isValidElement(node)) return typeof node === "string" ? text(node) : String(node ?? "");
  const el = node as ReactElement<Record<string, unknown>>;
  const name = nameOf(el.type);
  const { children, ...props } = el.props;
  const attrs = Object.entries(props).map(([k, v]) => attr(k, v)).filter((a): a is string => a !== null).join(" ");
  const open = attrs ? `${name} ${attrs}` : name;
  const parts = flat(children as ReactNode);
  if (!parts.length) return name ? `<${open} />` : "<></>";
  if (parts.every((p) => !isValidElement(p))) return `<${open}>${parts.map((p) => text(String(p))).join("")}</${name}>`;
  const pad = `${indent}  `;
  const lines = parts.map((p) => {
    if (isValidElement(p)) return pad + toJsx(p, pad);
    const s = String(p);
    return pad + (s !== s.trim() ? `{${JSON.stringify(s)}}` : text(s));
  });
  return `<${open}>\n${lines.join("\n")}\n${indent}</${name}>`;
}
