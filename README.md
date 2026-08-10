# FSK Audio File Transfer

An app that transmits small files as audio using Frequency Shift Keying (FSK), and a
complementary app that decodes the audio back into the original file.

## Repo Structure

- `/web` — Web app (JavaScript/TypeScript + Web Audio API)
- `/android` — Android app (Kotlin)
- `/ios` — iOS app (Swift)
- `SPEC.md` — Shared protocol spec (frequencies, baud rate, framing). **All 3 apps must follow this exactly.**

## Team

| Person | Phase 1 Role | Phase 2 Role | Phase 3 Role |
|---|---|---|---|
| Person A | Encoder | Error correction | Performance & testing |
| Person B | Decoder | Decoder robustness | iOS app |
| Person C | App shell / integration | File UI + Android start | Android app + polish |

## Getting Started

See `SPEC.md` for the protocol all platforms must implement.
