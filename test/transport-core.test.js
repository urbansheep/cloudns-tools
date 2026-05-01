import assert from "node:assert/strict";
import test from "node:test";
import { CLOUDNS_STATUS_MARKER_PREFIX, CURL_STATUS_MARKER } from "../src/transport/cloudns-transport-core.js";

test("CURL_STATUS_MARKER includes a runtime nonce", () => {
  assert.notEqual(CURL_STATUS_MARKER, "__CLOUDNS_HTTP_STATUS__:");
  assert.match(CURL_STATUS_MARKER, new RegExp(`^${CLOUDNS_STATUS_MARKER_PREFIX}[0-9a-f-]+:$`));
});
