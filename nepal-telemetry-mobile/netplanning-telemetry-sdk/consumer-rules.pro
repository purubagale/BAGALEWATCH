# No reflection-based access into this module's classes from outside
# NetTelemetry's own public API, so no keep rules are currently required.
# Referenced from build.gradle.kts via consumerProguardFiles() so a
# consuming app's R8/ProGuard pass doesn't fail looking for this file.
