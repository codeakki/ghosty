/*
 * 02_WiFiTest - join WiFi and reach the Ghosty server.
 *
 * Purpose: check credentials in secrets.h, signal strength, and that the pod
 *   can reach GHOSTY_SERVER_URL + "/health" on your laptop.
 *
 * Expected serial output (115200 baud):
 *   [02_WiFiTest] connecting to my-ssid.......
 *   [wifi] connected, ip=192.168.1.42 rssi=-55 dBm
 *   [http] GET http://192.168.1.10:3000/health -> 200
 *   [http] body: {"ok":true}
 *   (repeats every 10 s)
 *
 * What to check:
 *   - RSSI better than about -75 dBm (the ESP32-CAM PCB antenna is weak).
 *   - 200 from /health. A negative code means the TCP connection failed:
 *     server not running, wrong IP, laptop firewall, or a different subnet.
 *   - Brownout reset during connect = power problem (see hardware/wiring.md).
 */
#include <GhostyBoard.h>
#include <WiFi.h>
#include <HTTPClient.h>
#if __has_include(<secrets.h>)
#include <secrets.h>
#else
#error "Copy firmware/libraries/GhostyBoard/src/secrets.h.example to secrets.h and fill it in"
#endif

const char *HEALTH_URL = GHOSTY_SERVER_URL "/health";

bool connectWiFi(uint32_t timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[02_WiFiTest] connecting to %s", WIFI_SSID);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();
  return WiFi.status() == WL_CONNECTED;
}

void checkHealth() {
  WiFiClient client;
  HTTPClient http;
  http.begin(client, HEALTH_URL);
  http.addHeader("X-Device-Token", GHOSTY_DEVICE_TOKEN);
  int code = http.GET();
  Serial.printf("[http] GET %s -> %d\n", HEALTH_URL, code);
  if (code > 0) {
    Serial.print("[http] body: ");
    Serial.println(http.getString());
  } else {
    Serial.printf("[http] error: %s\n", HTTPClient::errorToString(code).c_str());
    blinkRed(3, 100, 100);
  }
  http.end();
}

void setup() {
  ghostyBoardInit();
  if (!connectWiFi(20000)) {
    Serial.printf("[wifi] FAILED, status=%d. Check SSID/password (2.4 GHz only).\n", (int)WiFi.status());
    while (true) blinkRed(1, 100, 900);
  }
  Serial.print("[wifi] connected, ip=");
  Serial.print(WiFi.localIP());
  Serial.printf(" rssi=%d dBm\n", (int)WiFi.RSSI());
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] lost connection, retrying");
    connectWiFi(20000);
  }
  setRedLed(true);
  checkHealth();
  setRedLed(false);
  Serial.printf("[wifi] rssi=%d dBm\n", (int)WiFi.RSSI());
  delay(10000);
}
