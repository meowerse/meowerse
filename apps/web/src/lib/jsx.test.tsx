import { forwardRef, memo } from "react";
import { describe, expect, it } from "vitest";
import { Alert, Button, Card, Kbd, Spinner, StatusLine, AppHeader } from "@meowerse/ui";
import { toJsx } from "./jsx";

describe("toJsx: snippets serialised from the same elements the previews render", () => {
  it("string props and text children on one line; forwardRef names resolve", () =>
    expect(toJsx(<Button variant="primary">save</Button>)).toBe('<Button variant="primary">save</Button>'));
  it("self-closes, writes true as a bare attribute and false/numbers in braces", () => {
    expect(toJsx(<Spinner size="lg" />)).toBe('<Spinner size="lg" />');
    expect(toJsx(<Button loading disabled={false}>go</Button>)).toBe("<Button loading disabled={false}>go</Button>");
  });
  it("names handlers instead of printing function bodies", () =>
    expect(toJsx(<Alert variant="error" onDismiss={() => {}}>no</Alert>)).toBe('<Alert variant="error" onDismiss={handleDismiss}>no</Alert>'));
  it("indents element children, keeps meaningful spaces, and writes fragments", () => {
    expect(toJsx(<Card title="profile"><p>hi</p></Card>)).toBe('<Card title="profile">\n  <p>hi</p>\n</Card>');
    expect(toJsx(<><Kbd>Shift</Kbd> + <Kbd>Enter</Kbd></>)).toBe('<>\n  <Kbd>Shift</Kbd>\n  {" + "}\n  <Kbd>Enter</Kbd>\n</>');
  });
  it("serialises object props as literals and element props inline", () => {
    expect(toJsx(<AppHeader session={{ loading: true, authenticated: false }} />))
      .toBe('<AppHeader session={{"loading":true,"authenticated":false}} />');
    expect(toJsx(<StatusLine state="fail" action={<Button>retry</Button>}>x</StatusLine>))
      .toBe('<StatusLine state="fail" action={<Button>retry</Button>}>x</StatusLine>');
  });
  it("braces text that JSX can't hold literally, and quotes that attributes can't", () => {
    expect(toJsx(<p>{"a {b}"}</p>)).toBe('<p>{"a {b}"}</p>');
    expect(toJsx(<Button title={'say "hi"'}>x</Button>)).toBe('<Button title={"say \\"hi\\""}>x</Button>');
  });
  it("drops null/undefined props and empty children, names non-handler functions after the prop", () => {
    expect(toJsx(<Button title={undefined} aria-label={null as unknown as string}>{false}{null}go</Button>)).toBe("<Button>go</Button>");
    const Slot = (_: { title: string; render: () => null }) => null;
    expect(toJsx(<Slot title="t" render={() => null} />)).toBe('<Slot title="t" render={render} />');
    expect(toJsx(<></>)).toBe("<></>");
  });
  it("writes bare text, numbers and nothing outside an element", () => {
    expect(toJsx("a <b>")).toBe('{"a <b>"}');
    expect(toJsx(3)).toBe("3");
    expect(toJsx(null)).toBe("");
  });
  it("keeps unpadded text between elements literal", () =>
    expect(toJsx(<p><Kbd>a</Kbd>then</p>)).toBe("<p>\n  <Kbd>a</Kbd>\n  then\n</p>"));
  it("calls anonymous and wrapped components something printable", () => {
    const Anon = forwardRef<HTMLSpanElement>(() => null);
    expect(toJsx(<Anon />)).toBe("<Component />");
    expect(toJsx(<Spinner />)).toBe("<Spinner />");
    const Wrapped = memo(() => null);
    expect(toJsx(<Wrapped />)).toBe("<Component />");
  });
});
