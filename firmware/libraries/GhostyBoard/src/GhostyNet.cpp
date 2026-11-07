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

namespace {
struct PodStateJob {
  const char *url;
  const char *token;
  const char *state;
};

void podStateTask(void *arg) {
  PodStateJob job = *static_cast<PodStateJob *>(arg);
  delete static_cast<PodStateJob *>(arg);
  if (WiFi.status() == WL_CONNECTED) {
    // Its own client: the shared ones in ghostyHttpBegin may be busy with /voice.
    WiFiClient *client;
    if (strncmp(job.url, "https://", 8) == 0) {
      WiFiClientSecure *secure = new WiFiClientSecure();
      secure->setCACert(GHOSTY_ROOT_CA);
      client = secure;
    } else {
      client = new WiFiClient();
    }
    HTTPClient http;
    if (http.begin(*client, job.url)) {
      http.setConnectTimeout(2000);
      http.setTimeout(2000);
      http.addHeader("Content-Type", "application/json");
      http.addHeader("X-Device-Token", job.token);
      http.addHeader("X-Ghosty-Client", "pod");
      char body[40];
      snprintf(body, sizeof body, "{\"state\":\"%s\"}", job.state);
      int code = http.POST(String(body));
      Serial.printf("[pod] POST /pod/state %s -> %d\n", job.state, code);
      http.end();
    }
    delete client;
  }
  vTaskDelete(nullptr);
}
}  // namespace

void ghostyPodStateAsync(const char *url, const char *deviceToken, const char *state) {
  PodStateJob *job = new PodStateJob{url, deviceToken, state};
  if (xTaskCreate(podStateTask, "podState", 10240, job, 1, nullptr) != pdPASS) delete job;
}
