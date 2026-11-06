#include "GhostyNet.h"

#include <WiFi.h>  // WiFiClient
#include <WiFiClientSecure.h>
#include "tls_roots.h"

bool ghostyHttpBegin(HTTPClient &http, const char *url) {
  // Function-local statics: sketches without networking never construct them.
  if (strncmp(url, "https://", 8) == 0) {
    static WiFiClientSecure secure;
    secure.setCACert(GHOSTY_ROOT_CA);
    return http.begin(secure, url);
  }
  static WiFiClient plain;
  return http.begin(plain, url);
}
