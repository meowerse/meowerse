// Client side of the playground: the real components, plus props the controls can't set (handlers).
import type { ComponentType } from "react";
import { Alert, Avatar, Badge, Button, Card, Checkbox, Code, Field, Kbd, Prompt, Spinner, StatusLine, Wordmark } from "@meowerse/ui";

const noop = () => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a heterogeneous registry of components
export type Playable = { component: ComponentType<any>; fixed?: Record<string, unknown> };

export const PLAYABLE: Record<string, Playable> = {
  Button: { component: Button }, Badge: { component: Badge }, Alert: { component: Alert },
  StatusLine: { component: StatusLine }, Field: { component: Field }, Checkbox: { component: Checkbox },
  Card: { component: Card }, Avatar: { component: Avatar }, Spinner: { component: Spinner }, Kbd: { component: Kbd },
  Wordmark: { component: Wordmark }, Code: { component: Code },
  Prompt: { component: Prompt, fixed: { onChange: noop, onSubmit: noop } },
};
