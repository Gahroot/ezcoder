// Lives in @prestyj/core — re-exported here so ezcoder call sites import
// Grok OAuth the same way they import the other providers.
export {
  loginXai,
  refreshXaiToken,
  grokCliBaseUrl,
  grokCliHeaders,
  isGrokCliEndpoint,
} from "@prestyj/core";
