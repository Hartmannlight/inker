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
#include <mbedtls/sha256.h>

#include "inker_ca.h"

namespace {
constexpr char kProfileId[] = "esp32-touch-reference-480x480";
constexpr char kManifestPath[] = "/api/v1/device-content";
constexpr char kPairingPath[] = "/api/device-enrollments/exchange";
constexpr char kCachePath[] = "/last-good.png";
constexpr size_t kMaxImageBytes = 3 * 1024 * 1024;
constexpr uint32_t kDefaultRefreshSeconds = 30;
constexpr uint32_t kSetupHoldMs = 4000;
constexpr int kBacklightPin = 38;

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
  if (png.openRAM(data, size, pngDraw) != PNG_SUCCESS) return false;
  pngWidth = png.getWidth();
  pngHeight = png.getHeight();
  if (pngWidth != display.width() || pngHeight != display.height()) {
    png.close();
    return false;
  }
  pngFrame = static_cast<uint16_t *>(ps_malloc(static_cast<size_t>(pngWidth) * pngHeight * sizeof(uint16_t)));
  if (!pngFrame) {
    png.close();
    return false;
  }
  const int result = png.decode(nullptr, 0);
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
  if (expectedSize == 0 || expectedSize > kMaxImageBytes) return false;
  const String url = artifactUrl.startsWith("http://") || artifactUrl.startsWith("https://")
      ? artifactUrl : config.baseUrl + artifactUrl;
  InkerHttp request;
  if (!request.begin(url)) return false;
  request.http().addHeader("Authorization", "Bearer " + config.credential);
  const int status = request.http().GET();
  if (status != HTTP_CODE_OK || request.http().getSize() != static_cast<int>(expectedSize)) return false;

  auto *buffer = static_cast<uint8_t *>(ps_malloc(expectedSize));
  if (!buffer) return false;
  WiFiClient *stream = request.http().getStreamPtr();
  const size_t received = stream->readBytes(buffer, expectedSize);
  const bool valid = received == expectedSize && sha256Hex(buffer, expectedSize).equalsIgnoreCase(expectedHash);
  bool displayed = false;
  if (valid) {
    displayed = displayPng(buffer, expectedSize);
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
  if (!config.manifestEtag.isEmpty()) request.http().addHeader("If-None-Match", config.manifestEtag);
  const int status = request.http().GET();
  const String refreshHeader = request.http().header("X-Refresh-After-Seconds");
  uint32_t nextRefresh = refreshHeader.toInt();
  if (nextRefresh == 0) nextRefresh = kDefaultRefreshSeconds;

  if (status == HTTP_CODE_NOT_MODIFIED) {
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
    clearPairing();
    showStatus("Pairing expired", "Hold the bottom-right corner for 4 seconds to set up again.");
    scheduleNextPoll(30);
    return;
  }
  if (status != HTTP_CODE_OK) {
    scheduleNextPoll(nextRefresh);
    return;
  }

  JsonDocument manifest;
  if (deserializeJson(manifest, request.http().getString())) {
    scheduleNextPoll(nextRefresh);
    return;
  }
  JsonVariant root = manifest.as<JsonVariant>();
  if (manifest["data"].is<JsonObject>()) root = manifest["data"].as<JsonVariant>();
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
  digitalWrite(kBacklightPin, HIGH);
  display.begin();
  touch.begin();
  touch.setRotation(ROTATION_NORMAL);
  LittleFS.begin(true);
  loadConfig();

  showStatus("Inker", "Starting ESP32 display client...");
  delay(700);
  const bool online = configureNetwork(config.baseUrl.isEmpty() || config.credential.isEmpty());
  if (!online) {
    if (!loadAndDisplayCache()) showStatus("Offline", "Hold bottom-right for 4 seconds to set up.");
    scheduleNextPoll(10);
    return;
  }
  if (!pendingPairingCode.isEmpty()) clearPairing();
  if (pairDevice()) pollContent();
}

void loop() {
  if (setupCornerHeld()) enterPortal();
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(50);
    return;
  }
  if (!config.credential.isEmpty() && static_cast<int32_t>(millis() - nextPollAt) >= 0) pollContent();
  delay(25);
}
