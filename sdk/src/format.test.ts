import assert from "node:assert/strict";
import test from "node:test";
import { isValidMetadataUri } from "./format.js";

test("isValidMetadataUri accepts https and ipfs URIs", () => {
  assert.equal(isValidMetadataUri("https://ipfs.example/metadata.json"), true);
  assert.equal(isValidMetadataUri("https://example.com/agent.json"), true);
  assert.equal(isValidMetadataUri("ipfs://QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o"), true);
});

test("isValidMetadataUri rejects dangerous schemes", () => {
  assert.equal(isValidMetadataUri("javascript:alert(1)"), false);
  assert.equal(isValidMetadataUri("data:text/html,<script>alert(1)</script>"), false);
  assert.equal(isValidMetadataUri("file:///etc/passwd"), false);
  assert.equal(isValidMetadataUri("http://example.com/agent.json"), false);
});

test("isValidMetadataUri rejects loopback and private IP literals", () => {
  assert.equal(isValidMetadataUri("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isValidMetadataUri("https://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isValidMetadataUri("https://127.0.0.1/metadata.json"), false);
  assert.equal(isValidMetadataUri("https://10.0.0.5/metadata.json"), false);
});

test("isValidMetadataUri rejects malformed input", () => {
  assert.equal(isValidMetadataUri("not a uri"), false);
  assert.equal(isValidMetadataUri(""), false);
});
