import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeAfterPreFlight } from "../src/graph/nodes.js";

describe("generation-first routing", () => {
  it("implements even when pre-flight returns an advisory rejection", () => {
    assert.equal(
      routeAfterPreFlight({
        preFlight: { is_business_valid: false, violation_reason: "needs review", checked_constraints: [] },
        preFlightAttempts: 3,
      } as never),
      "implement",
    );
  });
});
