// The "@testing-library/jest-dom/vitest" convenience entry imports its own copy
// of `vitest` and calls expect.extend on it; under bun's isolated linker that is a
// different module instance than the test's expect, so the matchers never attach.
// Import the matcher functions directly and extend the test-scoped expect instead
// (same behavior, resolver-safe).
import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
expect.extend(matchers);
