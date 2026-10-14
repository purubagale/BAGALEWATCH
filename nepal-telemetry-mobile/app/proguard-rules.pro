# Release build rules (2026-10-14).
#
# The app and the SDK use no reflection and build their JSON by hand, so R8
# needs no keep rules of its own; the libraries (Firebase, WorkManager,
# CameraX, osmdroid) ship their own.

# Drop debug, verbose and info log calls from the release build. Warnings
# and errors stay, so a field problem still shows in the device log.
-assumenosideeffects class android.util.Log {
    public static int d(...);
    public static int v(...);
    public static int i(...);
}

# Keep line numbers in crash reports, under a neutral file name.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
