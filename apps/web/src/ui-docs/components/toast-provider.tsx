import type { ComponentPage } from "../types";

export default {
  name: "ToastProvider",
  summary: "Short notices that appear at the bottom of the screen and go away on their own; useToast() shows one.",
  examples: [],
  interactiveOnly: true,
  a11y: [
    "Toasts appear in a polite live region labelled \"notifications\".",
    "Variants differ by border colour only, and toasts can't be paused or dismissed yet (audit U-13); keep them short and never the only place an error is shown.",
  ],
  dos: ["Confirm something that just happened: \"message sent\"."],
  donts: ["Don't put actions or long text in a toast."],
} satisfies ComponentPage;
