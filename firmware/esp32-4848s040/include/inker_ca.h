#pragma once

// Add the PEM root CA used by your Inker HTTPS endpoint here. The firmware
// deliberately refuses unverified TLS instead of silently accepting any cert.
static constexpr char INKER_ROOT_CA[] = R"PEM()PEM";
