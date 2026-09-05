#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <LittleFS.h>
#include <PNGdec.h>
#include <Preferences.h>
#include <Touch_GT911.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <WebServer.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>

#include "inker_ca.h"

namespace {
constexpr char kProfileId[] = "esp32-touch-reference-480x480";
constexpr char kFirmwareVersion[] = "0.3.2";
constexpr char kManifestPath[] = "/api/v1/device-content";
constexpr char kPairingPath[] = "/api/device-enrollments/exchange";
constexpr char kCachePath[] = "/last-good.png";
constexpr size_t kMaxImageBytes = 3 * 1024 * 1024;
constexpr uint32_t kDefaultRefreshSeconds = 30;
constexpr uint32_t kSetupHoldMs = 4000;
constexpr uint32_t kLanSetupTimeoutMs = 5 * 60 * 1000;
constexpr int kBacklightPin = 38;
// The JCZN backlight driver has a hardware dead zone below roughly 13% of the
// ESP32's 8-bit PWM range. Keep 0% as a real off state and map every non-zero
// user value linearly across the useful electrical range.
constexpr uint8_t kBacklightMinVisibleDuty = 40;

Arduino_ESP32RGBPanel rgbBus(
    39, 48, 47, 18, 17, 16, 21,
    11, 12, 13, 14, 0,
    8, 20, 3, 46, 9, 10,
    4, 5, 6, 7, 15);

Arduino_ST7701_RGBPanel display(
    &rgbBus, GFX_NOT_DEFINED, 0, true, 480, 480,
    st7701_type1_init_operations, sizeof(st7701_type1_init_operations), true,
    10, 8, 50, 10, 8, 20);

Touch_GT911 touch(19, 45, -1, -1, 480, 480);
Preferences preferences;
PNG png;
uint16_t *pngFrame = nullptr;
int pngWidth = 0;
int pngHeight = 0;

struct DeviceConfig {
  String baseUrl;
  String credential;
  String externalId;
  String credentialId;
  String profileId;
  String manifestEtag;
  String artifactHash;
} config;

String pendingPairingCode;
uint32_t refreshSeconds = kDefaultRefreshSeconds;
uint32_t nextPollAt = 0;
uint32_t touchStartedAt = 0;
bool setupTriggered = false;
WebServer lanSetupServer(80);
bool lanSetupActive = false;
bool lanSetupPairRequested = false;
bool lanSetupRoutesRegistered = false;
uint8_t consecutiveManifestFailures = 0;
uint32_t lanSetupExpiresAt = 0;
uint32_t lanSetupPairAt = 0;
String lanSetupCode;
uint8_t backlightBrightness = 100;

uint8_t backlightDutyForPercent(uint8_t percent) {
  percent = constrain(percent, 0, 100);
  if (percent == 0) return 0;
  constexpr uint16_t usefulRange = 255U - kBacklightMinVisibleDuty;
  return static_cast<uint8_t>(kBacklightMinVisibleDuty +
      ((static_cast<uint16_t>(percent - 1U) * usefulRange + 49U) / 99U));
}

void setBacklightBrightness(uint8_t percent, bool persist = true) {
  percent = constrain(percent, 0, 100);
  if (percent == backlightBrightness && persist) return;
  backlightBrightness = percent;
  const uint8_t duty = backlightDutyForPercent(percent);
  analogWrite(kBacklightPin, duty);
  if (persist) preferences.putUChar("brightness", percent);
  Serial.printf("[inker] backlight brightness=%u%% pwm=%u\n",
                static_cast<unsigned>(percent), static_cast<unsigned>(duty));
}

void showStatus(const String &title, const String &detail = "") {
  display.fillScreen(BLACK);
  display.setTextColor(WHITE);
  display.setTextSize(3);
  display.setCursor(22, 28);
  display.println(title);
  display.setTextSize(2);
  display.setCursor(22, 88);
  display.setTextWrap(true);
  display.println(detail);
}

String normalizedBaseUrl(String value) {
  value.trim();
  while (value.endsWith("/")) value.remove(value.length() - 1);
  if (!(value.startsWith("http://") || value.startsWith("https://"))) return "";
  return value;
}

String normalizedPairingCode(String value) {
  value.trim();
  value.toUpperCase();
  value.replace("-", "");
  value.replace(" ", "");
  value.replace("O", "0");
  value.replace("I", "1");
  value.replace("L", "1");
  if (value.length() != 10) return "";
  for (size_t i = 0; i < value.length(); ++i) {
    if (strchr("0123456789ABCDEFGHJKMNPQRSTVWXYZ", value[i]) == nullptr) return "";
  }
  return value;
}

void startLanSetup();

String newLanSetupCode() {
  constexpr char alphabet[] = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  char output[9] = {};
  for (size_t i = 0; i < sizeof(output) - 1; ++i) {
    output[i] = alphabet[esp_random() % (sizeof(alphabet) - 1)];
  }
  return String(output);
}

void loadConfig() {
  preferences.begin("inker", false);
  if (preferences.isKey("url")) config.baseUrl = preferences.getString("url");
  if (preferences.isKey("token")) config.credential = preferences.getString("token");
  if (preferences.isKey("device")) config.externalId = preferences.getString("device");
  if (preferences.isKey("cred-id")) config.credentialId = preferences.getString("cred-id");
  if (preferences.isKey("profile")) config.profileId = preferences.getString("profile");
  if (preferences.isKey("manifest")) config.manifestEtag = preferences.getString("manifest");
  if (preferences.isKey("artifact")) config.artifactHash = preferences.getString("artifact");
  if (preferences.isKey("pair-code")) pendingPairingCode = preferences.getString("pair-code");
  if (preferences.isKey("brightness")) backlightBrightness = preferences.getUChar("brightness", 100);

  // A newer firmware may understand manifest fields that the previous version
  // ignored. Force one full response after an upgrade instead of accepting a
  // cached 304 generated by the older parser (0.2.3, for example, stored the
  // ETag but did not yet apply displayControl.brightness).
  const String storedFirmwareVersion = preferences.getString("fw-version", "");
  if (storedFirmwareVersion != kFirmwareVersion) {
    config.manifestEtag = "";
    preferences.remove("manifest");
    preferences.putString("fw-version", kFirmwareVersion);
  }
}

void saveIdentity() {
  preferences.putString("url", config.baseUrl);
  preferences.putString("token", config.credential);
  preferences.putString("device", config.externalId);
  preferences.putString("cred-id", config.credentialId);
  preferences.putString("profile", config.profileId);
}

void saveCacheMetadata() {
  preferences.putString("manifest", config.manifestEtag);
  preferences.putString("artifact", config.artifactHash);
}

void clearPairing() {
  config.credential = "";
  config.externalId = "";
  config.credentialId = "";
  config.profileId = "";
  config.manifestEtag = "";
  config.artifactHash = "";
  preferences.remove("token");
  preferences.remove("device");
  preferences.remove("cred-id");
  preferences.remove("profile");
  preferences.remove("manifest");
  preferences.remove("artifact");
}

String setupApName() {
  uint64_t chip = ESP.getEfuseMac();
  char suffix[7];
  snprintf(suffix, sizeof(suffix), "%06llX", chip & 0xFFFFFFULL);
  return String("Inker-Setup-") + suffix;
}

bool configureNetwork(bool forced) {
  char urlValue[161] = {};
  char codeValue[17] = {};
  config.baseUrl.substring(0, sizeof(urlValue) - 1).toCharArray(urlValue, sizeof(urlValue));
  pendingPairingCode.substring(0, sizeof(codeValue) - 1).toCharArray(codeValue, sizeof(codeValue));

  WiFiManager manager;
  manager.setConfigPortalTimeout(300);
  manager.setConnectTimeout(20);
  manager.setConnectRetries(2);
  manager.setTitle("Inker ESP32 setup");
  WiFiManagerParameter url("inker_url", "Inker URL (http(s)://host:port)", urlValue, sizeof(urlValue));
  WiFiManagerParameter code("pair_code", "Pairing code (XXXX-XXXX-XX)", codeValue, sizeof(codeValue));
  manager.addParameter(&url);
  manager.addParameter(&code);

  const String apName = setupApName();
  showStatus("Inker setup", "Connect to " + apName + " and open 192.168.4.1");
  const bool connected = forced ? manager.startConfigPortal(apName.c_str()) : manager.autoConnect(apName.c_str());
  if (!connected) return false;

  const String newUrl = normalizedBaseUrl(url.getValue());
  if (!newUrl.isEmpty() && newUrl != config.baseUrl) {
    config.baseUrl = newUrl;
    clearPairing();
  }
  const String submittedCode = normalizedPairingCode(String(code.getValue()));
  if (!submittedCode.isEmpty()) {
    pendingPairingCode = submittedCode;
    preferences.putString("pair-code", pendingPairingCode);
  }
  preferences.putString("url", config.baseUrl);
  Serial.printf("[inker] setup saved: wifi=%s url=%s pairing-code-length=%u\n",
                WiFi.status() == WL_CONNECTED ? "connected" : "disconnected",
                config.baseUrl.isEmpty() ? "missing" : "configured",
                pendingPairingCode.length());
  return !config.baseUrl.isEmpty();
}

void stopLanSetup() {
  if (!lanSetupActive) return;
  lanSetupServer.stop();
  lanSetupActive = false;
  lanSetupCode = "";
}

void handleLanSetupHome() {
  const char page[] = R"HTML(<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inker ESP32 setup</title></head><body><h1>Inker ESP32 LAN setup</h1><p>Enter the one-time code shown on the display, then provide the new Inker URL and pairing code.</p><form method="post" action="/setup"><label>Display code <input name="session_code" required maxlength="8" autocapitalize="characters"></label><br><label>Inker URL <input name="inker_url" required maxlength="160" placeholder="http://192.168.1.20"></label><br><label>Pairing code <input name="pair_code" required maxlength="16" placeholder="XXXX-XXXX-XX" autocapitalize="characters"></label><br><button type="submit">Save and pair</button></form></body></html>)HTML";
  lanSetupServer.send(200, "text/html; charset=utf-8", page);
}

void handleLanSetupSubmit() {
  if (!lanSetupActive || lanSetupServer.arg("session_code") != lanSetupCode) {
    lanSetupServer.send(403, "text/plain", "Invalid or expired display code.");
    return;
  }

  const String newUrl = normalizedBaseUrl(lanSetupServer.arg("inker_url"));
  const String newCode = normalizedPairingCode(lanSetupServer.arg("pair_code"));
  if (newUrl.isEmpty() || newCode.isEmpty()) {
    lanSetupServer.send(400, "text/plain", "Enter a valid http(s) URL and a 10-character pairing code.");
    return;
  }

  config.baseUrl = newUrl;
  clearPairing();
  pendingPairingCode = newCode;
  preferences.putString("url", config.baseUrl);
  preferences.putString("pair-code", pendingPairingCode);
  lanSetupPairRequested = true;
  lanSetupPairAt = millis() + 250;
  lanSetupServer.send(200, "text/plain", "Saved. The display is now pairing with Inker.");
}

void startLanSetup() {
  if (WiFi.status() != WL_CONNECTED) return;
  lanSetupCode = newLanSetupCode();
  lanSetupExpiresAt = millis() + kLanSetupTimeoutMs;
  lanSetupPairRequested = false;
  if (!lanSetupRoutesRegistered) {
    lanSetupServer.on("/", HTTP_GET, handleLanSetupHome);
    lanSetupServer.on("/setup", HTTP_POST, handleLanSetupSubmit);
    lanSetupRoutesRegistered = true;
  }
  lanSetupServer.begin();
  lanSetupActive = true;
  showStatus("LAN setup", "Open http://" + WiFi.localIP().toString() + " and enter code " + lanSetupCode);
  Serial.printf("[inker] LAN setup active at http://%s for %u seconds\n",
                WiFi.localIP().toString().c_str(), kLanSetupTimeoutMs / 1000);
}

class InkerHttp {
 public:
  bool begin(const String &url) {
    if (url.startsWith("https://")) {
      if (strlen(INKER_ROOT_CA) == 0) return false;
      secure_.reset(new WiFiClientSecure());
      secure_->setCACert(INKER_ROOT_CA);
      return http_.begin(*secure_, url);
    }
    plain_.reset(new WiFiClient());
    return http_.begin(*plain_, url);
  }

  HTTPClient &http() { return http_; }
  ~InkerHttp() { http_.end(); }

 private:
  HTTPClient http_;
  std::unique_ptr<WiFiClient> plain_;
  std::unique_ptr<WiFiClientSecure> secure_;
};

bool pairDevice() {
  if (!config.credential.isEmpty()) return true;
  if (pendingPairingCode.length() != 10) {
    Serial.printf("[inker] pairing skipped: normalized code length is %u\n", pendingPairingCode.length());
    showStatus("Pairing needed", "Open setup and enter the code shown by Inker (XXXX-XXXX-XX).");
    return false;
  }

  InkerHttp request;
  if (!request.begin(config.baseUrl + kPairingPath)) {
    showStatus("TLS not set up", "Add the Inker root CA to include/inker_ca.h, or use local HTTP enabled by Inker.");
    return false;
  }
  request.http().addHeader("Content-Type", "application/json");
  JsonDocument body;
  body["code"] = pendingPairingCode;
  String payload;
  serializeJson(body, payload);
  const int status = request.http().POST(payload);
  Serial.printf("[inker] pairing response: HTTP %d\n", status);
  if (status != HTTP_CODE_OK && status != HTTP_CODE_CREATED) {
    showStatus("Pairing failed", "Inker returned HTTP " + String(status) + ". Check URL, code, and HTTP/TLS policy.");
    return false;
  }

  JsonDocument response;
  if (deserializeJson(response, request.http().getString())) {
    showStatus("Pairing failed", "Inker returned an invalid response.");
    return false;
  }
  JsonVariant root = response.as<JsonVariant>();
  if (response["data"].is<JsonObject>()) root = response["data"].as<JsonVariant>();
  config.credential = root["credential"] | "";
  config.credentialId = root["credentialId"] | "";
  config.externalId = root["device"]["externalId"] | "";
  config.profileId = root["device"]["profileId"] | "";
  if (config.credential.isEmpty() || config.profileId != kProfileId) {
    clearPairing();
    showStatus("Wrong device profile", "Pair this box with the JCZN ESP32-4848S040 profile in Inker.");
    return false;
  }
  pendingPairingCode = "";
  preferences.remove("pair-code");
  saveIdentity();
  showStatus("Paired", "Waiting for published content...");
  return true;
}

int pngDraw(PNGDRAW *line) {
  if (!pngFrame || line->y < 0 || line->y >= pngHeight || line->iWidth != pngWidth) return 0;
  png.getLineAsRGB565(line, pngFrame + line->y * pngWidth, PNG_RGB565_LITTLE_ENDIAN, 0xffffffff);
  return 1;
}

bool displayPng(uint8_t *data, size_t size) {
  const int openResult = png.openRAM(data, size, pngDraw);
  if (openResult != PNG_SUCCESS) {
    Serial.printf("[inker] PNG open failed: %d\n", openResult);
    return false;
  }
  pngWidth = png.getWidth();
  pngHeight = png.getHeight();
  Serial.printf("[inker] PNG dimensions=%dx%d display=%dx%d\n",
                pngWidth, pngHeight, display.width(), display.height());
  if (pngWidth != display.width() || pngHeight != display.height()) {
    png.close();
    return false;
  }
  pngFrame = static_cast<uint16_t *>(ps_malloc(static_cast<size_t>(pngWidth) * pngHeight * sizeof(uint16_t)));
  if (!pngFrame) {
    Serial.printf("[inker] PNG frame allocation failed: free-heap=%u free-psram=%u\n",
                  ESP.getFreeHeap(), ESP.getFreePsram());
    png.close();
    return false;
  }
  const int result = png.decode(nullptr, 0);
  Serial.printf("[inker] PNG decoder result=%d\n", result);
  png.close();
  if (result == PNG_SUCCESS) display.draw16bitRGBBitmap(0, 0, pngFrame, pngWidth, pngHeight);
  free(pngFrame);
  pngFrame = nullptr;
  return result == PNG_SUCCESS;
}

bool loadAndDisplayCache() {
  File file = LittleFS.open(kCachePath, "r");
  if (!file || file.size() == 0 || file.size() > kMaxImageBytes) return false;
  const size_t size = file.size();
  auto *buffer = static_cast<uint8_t *>(ps_malloc(size));
  if (!buffer) return false;
  const bool read = file.read(buffer, size) == size;
  file.close();
  const bool displayed = read && displayPng(buffer, size);
  free(buffer);
  return displayed;
}

String sha256Hex(const uint8_t *data, size_t size) {
  uint8_t digest[32];
  mbedtls_sha256_ret(data, size, digest, 0);
  char output[65];
  for (size_t i = 0; i < sizeof(digest); ++i) snprintf(output + i * 2, 3, "%02x", digest[i]);
  output[64] = '\0';
  return output;
}

bool downloadAndDisplay(const String &artifactUrl, const String &expectedHash, size_t expectedSize) {
  if (expectedSize == 0 || expectedSize > kMaxImageBytes) {
    Serial.printf("[inker] artifact rejected: expected-size=%u\n", static_cast<unsigned>(expectedSize));
    return false;
  }
  const String url = artifactUrl.startsWith("http://") || artifactUrl.startsWith("https://")
      ? artifactUrl : config.baseUrl + artifactUrl;
  InkerHttp request;
  if (!request.begin(url)) {
    Serial.println("[inker] artifact request begin failed");
    return false;
  }
  request.http().addHeader("Authorization", "Bearer " + config.credential);
  const int status = request.http().GET();
  const int contentLength = request.http().getSize();
  Serial.printf("[inker] artifact response: HTTP %d length=%d expected=%u\n",
                status, contentLength, static_cast<unsigned>(expectedSize));
  if (status != HTTP_CODE_OK || (contentLength >= 0 && contentLength != static_cast<int>(expectedSize))) return false;

  auto *buffer = static_cast<uint8_t *>(ps_malloc(expectedSize));
  if (!buffer) return false;
  WiFiClient *stream = request.http().getStreamPtr();
  const size_t received = stream->readBytes(buffer, expectedSize);
  const bool valid = received == expectedSize && sha256Hex(buffer, expectedSize).equalsIgnoreCase(expectedHash);
  Serial.printf("[inker] artifact received=%u hash-valid=%s\n",
                static_cast<unsigned>(received), valid ? "yes" : "no");
  bool displayed = false;
  if (valid) {
    displayed = displayPng(buffer, expectedSize);
    Serial.printf("[inker] PNG decode=%s\n", displayed ? "ok" : "failed");
    if (displayed) {
      File cache = LittleFS.open(kCachePath, "w");
      if (cache) {
        cache.write(buffer, expectedSize);
        cache.close();
      }
    }
  }
  free(buffer);
  return displayed;
}

void scheduleNextPoll(uint32_t seconds) {
  refreshSeconds = constrain(seconds, 5U, 3600U);
  nextPollAt = millis() + refreshSeconds * 1000UL;
}

void pollContent() {
  InkerHttp request;
  if (!request.begin(config.baseUrl + kManifestPath)) {
    scheduleNextPoll(30);
    return;
  }
  const char *responseHeaders[] = {"ETag", "X-Refresh-After-Seconds"};
  request.http().collectHeaders(responseHeaders, 2);
  request.http().addHeader("Authorization", "Bearer " + config.credential);
  request.http().addHeader("X-Inker-Wifi-Rssi", String(WiFi.RSSI()));
  request.http().addHeader("X-Inker-Firmware-Version", kFirmwareVersion);
  if (!config.manifestEtag.isEmpty()) request.http().addHeader("If-None-Match", config.manifestEtag);
  const int status = request.http().GET();
  Serial.printf("[inker] manifest response: HTTP %d\n", status);
  const String refreshHeader = request.http().header("X-Refresh-After-Seconds");
  uint32_t nextRefresh = refreshHeader.toInt();
  if (nextRefresh == 0) nextRefresh = kDefaultRefreshSeconds;

  if (status == HTTP_CODE_NOT_MODIFIED) {
    consecutiveManifestFailures = 0;
    // A manifest is useful only after its artifact was rendered successfully.
    // Recover from older firmware that cached the ETag after a failed decode.
    if (config.artifactHash.isEmpty()) {
      config.manifestEtag = "";
      preferences.remove("manifest");
      scheduleNextPoll(5);
      return;
    }
    scheduleNextPoll(nextRefresh);
    return;
  }
  if (status == HTTP_CODE_UNAUTHORIZED || status == HTTP_CODE_FORBIDDEN) {
    consecutiveManifestFailures = 0;
    clearPairing();
    showStatus("Pairing expired", "Hold the bottom-right corner for 4 seconds to set up again.");
    scheduleNextPoll(30);
    return;
  }
  if (status != HTTP_CODE_OK) {
    if (!lanSetupActive && ++consecutiveManifestFailures >= 3) {
      startLanSetup();
    }
    scheduleNextPoll(nextRefresh);
    return;
  }

  consecutiveManifestFailures = 0;

  JsonDocument manifest;
  if (deserializeJson(manifest, request.http().getString())) {
    scheduleNextPoll(nextRefresh);
    return;
  }
  JsonVariant root = manifest.as<JsonVariant>();
  if (manifest["data"].is<JsonObject>()) root = manifest["data"].as<JsonVariant>();
  JsonVariant brightness = root["metadata"]["displayControl"]["brightness"];
  if (!brightness.isNull()) {
    setBacklightBrightness(static_cast<uint8_t>(constrain(brightness.as<int>(), 0, 100)));
  }
  const char *profileId = root["profileId"] | "";
  JsonArray artifacts = root["artifacts"].as<JsonArray>();
  if (String(profileId) != kProfileId || artifacts.isNull() || artifacts.size() == 0) {
    scheduleNextPoll(nextRefresh);
    return;
  }
  JsonObject artifact = artifacts[0];
  const String mimeType = artifact["mimeType"] | "";
  const String url = artifact["url"] | "";
  const String hash = artifact["sha256"] | "";
  const size_t size = artifact["sizeBytes"] | 0;
  const uint32_t manifestRefresh = root["refresh"]["refreshAfterSeconds"] | nextRefresh;
  bool artifactReady = mimeType == "image/png" && hash == config.artifactHash && !hash.isEmpty();
  if (mimeType == "image/png" && !artifactReady) {
    artifactReady = downloadAndDisplay(url, hash, size);
    if (artifactReady) config.artifactHash = hash;
  }
  if (artifactReady) {
    const String responseEtag = request.http().header("ETag");
    if (!responseEtag.isEmpty()) config.manifestEtag = responseEtag;
    saveCacheMetadata();
  } else {
    config.manifestEtag = "";
    preferences.remove("manifest");
  }
  scheduleNextPoll(manifestRefresh);
}

bool setupCornerHeld() {
  touch.read();
  bool pressed = false;
  for (int i = 0; i < touch.touches; ++i) {
    // With this board's GT911 mounting, raw high/high is the physical
    // bottom-right corner shown to the user.
    if (touch.points[i].x > 380 && touch.points[i].y > 380) pressed = true;
  }
  if (!pressed) {
    touchStartedAt = 0;
    setupTriggered = false;
    return false;
  }
  if (touchStartedAt == 0) touchStartedAt = millis();
  if (!setupTriggered && millis() - touchStartedAt >= kSetupHoldMs) {
    setupTriggered = true;
    return true;
  }
  return false;
}

void enterPortal() {
  if (WiFi.status() == WL_CONNECTED) {
    startLanSetup();
    return;
  }
  if (!configureNetwork(true)) {
    showStatus("Setup timed out", "Hold the bottom-right corner for 4 seconds to retry.");
    return;
  }
  if (!pendingPairingCode.isEmpty()) clearPairing();
  if (pairDevice()) {
    config.manifestEtag = "";
    nextPollAt = 0;
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(kBacklightPin, OUTPUT);
  analogWrite(kBacklightPin, 255);
  display.begin();
  touch.begin();
  touch.setRotation(ROTATION_NORMAL);
  LittleFS.begin(true);
  loadConfig();
  setBacklightBrightness(backlightBrightness, false);

  showStatus("Inker", "Starting ESP32 display client...");
  delay(700);
  // Always try remembered Wi-Fi first. A revoked or stale Inker pairing must
  // not force the AP path: once Wi-Fi is restored, the physical recovery
  // gesture can expose the short-lived LAN setup page instead.
  const bool online = configureNetwork(false);
  if (!online) {
    if (!loadAndDisplayCache()) showStatus("Offline", "Hold bottom-right for 4 seconds to set up.");
    scheduleNextPoll(10);
    return;
  }
  if (!pendingPairingCode.isEmpty()) clearPairing();
  if (pairDevice()) pollContent();
}

void loop() {
  if (lanSetupActive) {
    lanSetupServer.handleClient();
    if (static_cast<int32_t>(millis() - lanSetupExpiresAt) >= 0) {
      stopLanSetup();
      showStatus("LAN setup timed out", "Hold the bottom-right corner for 4 seconds to retry.");
    } else if (lanSetupPairRequested && static_cast<int32_t>(millis() - lanSetupPairAt) >= 0) {
      lanSetupPairRequested = false;
      if (pairDevice()) {
        stopLanSetup();
        config.manifestEtag = "";
        nextPollAt = 0;
      } else {
        showStatus("Pairing failed", "Correct the URL or code at http://" + WiFi.localIP().toString());
      }
    }
  }
  if (setupCornerHeld()) enterPortal();
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(50);
    return;
  }
  if (!config.credential.isEmpty() && static_cast<int32_t>(millis() - nextPollAt) >= 0) pollContent();
  delay(25);
}
