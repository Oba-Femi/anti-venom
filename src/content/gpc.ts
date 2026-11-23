/**
 * Runs in the page's MAIN world at document_start (registered by the
 * background only when Global Privacy Control is enabled). Exposes the GPC
 * signal to page scripts, matching the Sec-GPC request header.
 * Spec: https://privacycg.github.io/gpc-spec/
 */
if (!('globalPrivacyControl' in Navigator.prototype)) {
  Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
    get: () => true,
    configurable: true,
    enumerable: true,
  });
}
