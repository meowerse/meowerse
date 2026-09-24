// The "@testing-library/jest-dom/vitest" convenience entry imports its own copy
// of `vitest` and calls expect.extend on it; under bun's isolated linker that is a
// different module instance than the test's expect, so the matchers never attach.
// Import the matcher functions directly and extend the test-scoped expect instead
// (same behavior, resolver-safe).
import { expect, vi } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);

// Cat3D's asset imports (Vite/Astro resolve them in apps; under vitest they are plain stubs).
vi.mock("../src/cat3d/cat-poster.webp", () => ({ default: "cat-poster.webp" }));
vi.mock("../src/cat3d/cat.bin?url", () => ({ default: "cat.bin" }));
