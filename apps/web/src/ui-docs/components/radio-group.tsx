import { RadioGroup } from "@meowerse/ui";
import type { ComponentPage } from "../types";
const noop = () => {};
const options = [
  { label: "follow the system", value: "system" },
  { label: "dark", value: "dark" },
  { label: "light", value: "light", hint: "day paper" },
];

export default {
  name: "RadioGroup",
  summary: "A labelled group of native radio buttons, each in a 44 px row, with optional hints.",
  examples: [
    { title: "with hints", node: (scope) => <RadioGroup name={`theme-${scope}`} legend="theme" options={options} value="system" onChange={noop} />, html: true },
  ],
  a11y: ["A fieldset with a legend; each option's label is tied to its radio.", "Arrow keys move between options, as with any native radio group."],
  keys: [["Tab", "enters the group"], ["Arrow keys", "move the choice"]],
  dos: ["Use it for two to five exclusive choices."],
  donts: ["Don't use it for a single yes/no; use a checkbox."],
} satisfies ComponentPage;
