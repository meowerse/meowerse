import { Cat3D } from "@meowerse/ui/cat3d";
import type { ComponentPage } from "../types";

export default {
  name: "Cat3D",
  from: "@meowerse/ui/cat3d",
  summary: "The low-poly green cat from the alxnko.dev desk: a still poster first, then a tiny WebGL2 renderer whose head follows the pointer.",
  examples: [
    { title: "the poster", note: "it comes alive on /ui/cat3d/ and on the home page", node: <Cat3D size={160} /> },
  ],
  a11y: [
    "Decorative: aria-hidden, with nothing focusable, so a failure costs nothing.",
    "Reduced motion, save-data, no WebGL2 or a failed load all keep the still image.",
  ],
  dos: ["Render its markup on the server and call attachAllCat3D() from a small script, or use <Cat3D> in a React island."],
  donts: ["Don't put information in it.", "Don't use it in meowsenger (spec §4)."],
} satisfies ComponentPage;
