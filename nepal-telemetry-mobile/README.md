# nepal-telemetry-project

This is a ready-to-open Android Studio project with two modules:

- **`netplanning-telemetry-sdk`** -- the actual deliverable: the mobile-app
  integration layer for Nepal Telecom's crowdsourced coverage/drive-test
  pilot (background cell + signal + GPS sampling, local queueing, batched
  upload, opt-in gating, pseudonymous device ID). See that module's own
  `README.md` for what it does and how to integrate it into Nepal Telecom's
  real app. It has no UI of its own, by design -- the pilot's real front
  end is a separate effort.

- **`app`** -- a minimal demo/test harness around the SDK, NOT the pilot's
  real UI. Four buttons (Opt In, Opt Out, Sample Now, Refresh Status) and a
  status readout, wired to exactly the calls documented in the SDK's
  README (`NetTelemetry.init/optIn/optOut/sampleNow/getStatus`). Its only
  job is to make the SDK something you can actually install, run, and
  press buttons on -- to catch real compile/runtime issues before this
  goes anywhere near Nepal Telecom's own app or a pilot device.

## Why this project exists

The SDK module was originally written and manually line-by-line audited
against real Android API signatures, but in an environment with **no**
Android SDK, no emulator, and no reachable Google Maven repository -- so
it had never actually been compiled. This wrapping project exists purely
so it can be opened in a real Android Studio and built for real, on a
machine with normal internet access.

## How to build

1. Unzip this project anywhere on your machine.
2. Open the folder in Android Studio ("Open" -> select this folder, not a
   file inside it).
3. Let Gradle sync. The very first sync needs to download the Gradle 8.7
   distribution, the Android Gradle Plugin, Kotlin, and the AndroidX/Play
   Services libraries the SDK depends on -- this requires your machine's
   own internet access to Google's Maven repo and the Gradle Plugin
   Portal (blocked from the sandbox this project was assembled in, which
   is exactly why this step couldn't happen until now).
4. Once sync succeeds, run the `app` configuration on a device or
   emulator (API 26+).
5. Grant location (and phone-state, on some OEMs) permission when the
   demo asks, tap "Opt In", then "Sample Now", then "Refresh Status" --
   the queued-sample count should go from 0 to 1 (or more, once
   WorkManager's 15-minute periodic tick fires in the background).

## If the build fails

This project was assembled and its Gradle wrapper generated in a sandbox
with no Android SDK and no access to Google's Maven repo, so **this exact
combination of AGP 8.5.2 / Kotlin 2.0.21 / Gradle 8.7 / the library
versions in each module's `build.gradle.kts` has not actually been test-
compiled**. If Android Studio reports a version-compatibility error or a
missing dependency, that is the first thing to fix -- Android Studio's own
"Upgrade Assistant" / suggested quick-fixes for AGP-Gradle version
mismatches are normally reliable here. Please report back whatever error
comes up; the source can be corrected and re-delivered.

## What's deliberately not here

No launcher icon resources (the demo app uses the system default icon), no
CI config, no signing config, no ProGuard/R8 rules beyond the SDK's own
`consumer-rules.pro`. None of that matters for a local debug build used to
exercise the SDK.
