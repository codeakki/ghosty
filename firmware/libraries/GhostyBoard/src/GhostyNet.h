// GhostyNet.h - HTTP(S) helper for the networked sketches.
//
// GHOSTY_SERVER_URL may be http:// (server on the LAN) or https:// (server on
// AWS). https:// connections are verified against the roots in tls_roots.h.
#pragma once

#include <HTTPClient.h>

// Opens `url` on `http` with a plain or TLS client to match the URL scheme.
// Returns false if the URL cannot be parsed.
bool ghostyHttpBegin(HTTPClient &http, const char *url);
