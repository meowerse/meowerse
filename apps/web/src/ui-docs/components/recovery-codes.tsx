import { RecoveryCodes } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "RecoveryCodes",
  summary: "A grid of one-time recovery codes with a \"copy all\" button.",
  examples: [
    { title: "eight codes", node: <RecoveryCodes codes={["b7qk-2m9x", "t4nw-8rd3", "h2vc-6yp1", "m9zs-4kt7", "q3lf-7bn2", "w8xd-1gj5", "e6pr-3hm8", "u1ty-9cs4"]} /> },
  ],
  a11y: ["The codes are a list, shown exactly as issued.", "\"copy all\" gives no feedback yet (audit U-19); that is fixed in the accounts redesign (sub-project 3)."],
  dos: ["Show codes once, right after they are made, and say they won't be shown again."],
  donts: ["Don't send codes by email or show them again later."],
} satisfies ComponentPage;
