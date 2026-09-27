import { describe, it, expect } from "vitest";
import { buildSummary } from "../../../src/commands/doctor/output.js";

describe("buildSummary", () => {
  it("counts ok, warn, and fail checks separately", () => {
    const summary = buildSummary([
      { id: "a", status: "ok", detail: "", fix: "" },
      { id: "b", status: "warn", detail: "", fix: "" },
      { id: "c", status: "fail", detail: "", fix: "" },
      { id: "d", status: "fail", detail: "", fix: "" },
    ]);
    expect(summary).toEqual({ ok_count: 1, warn_count: 1, fail_count: 2 });
  });

  it("returns all-zero for an empty check list", () => {
    expect(buildSummary([])).toEqual({ ok_count: 0, warn_count: 0, fail_count: 0 });
  });
});
