// Minimal demo/test-harness app -- NOT the pilot's real front end (that is
// a separate effort, by this project's own task split). This exists only
// so netplanning-telemetry-sdk is something a real Android Studio build
// can compile, install, and exercise with actual button presses, on a
// real device, before it goes anywhere near Nepal Telecom's own app.
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing (2026-10-14). The keystore and its passwords stay on the
// build PC in keystore.properties at this project's root (never in git):
// storeFile, storePassword, keyAlias, keyPassword. Without that file a
// release build is produced unsigned and cannot be installed.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// See defaultConfig: major.minor.patch.
val appVersionName = "1.2.5"

android {
    namespace = "np.nepaltelecom.telemetry.demo"
    compileSdk = 34

    defaultConfig {
        applicationId = "np.nepaltelecom.telemetry.demo"
        minSdk = 26
        targetSdk = 34
        // The app's version (2026-10-16), the one place to change it. Raise it
        // for every APK given out: the name is shown in Settings and sent with
        // registration and problem reports, and Android installs an update only
        // over a lower code. The code follows the name: 1.1.0 -> 10100.
        versionName = appVersionName
        versionCode = appVersionName.split(".").map { it.toInt() }
            .let { (major, minor, patch) -> major * 10000 + minor * 100 + patch }
    }

    buildFeatures {
        buildConfig = true
    }

    // Two editions (2026-10-14). "standard" is the normal app. "collector" is
    // for a small group of staff gathering test data: sharing has no time
    // limit (it runs until the user stops it); a reading is taken every
    // 15 seconds, plus a speed test every 30 minutes on mobile data. Same application ID, so Firebase keeps working
    // and installing one replaces the other on a phone.
    flavorDimensions += "edition"
    productFlavors {
        create("standard") {
            dimension = "edition"
            buildConfigField("boolean", "COLLECTOR", "false")
        }
        create("collector") {
            dimension = "edition"
            versionNameSuffix = "-collector"
            buildConfigField("boolean", "COLLECTOR", "true")
        }
    }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        // Release (2026-10-14, after the MobSF scan): not debuggable, code
        // shrunk and obfuscated by R8, debug logs stripped (proguard-rules.pro),
        // no cleartext exception (that lives in src/debug only).
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation(project(":netplanning-telemetry-sdk"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    // Map tab (2026-10-04): OpenStreetMap tiles, no API key needed.
    implementation("org.osmdroid:osmdroid-android:6.1.18")
    // Push for trace requests (2026-10-06). Works only once google-services.json is in place.
    implementation(platform("com.google.firebase:firebase-bom:33.1.2"))
    implementation("com.google.firebase:firebase-messaging")
    // Retry/backoff for "Register this phone" (2026-10-08) -- same version
    // netplanning-telemetry-sdk already uses for its own upload/rescue
    // workers; declared again here because Gradle `implementation` deps
    // aren't transitively visible to a dependent module.
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    // Site photo screen (2026-10-11): in-app camera preview and capture.
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
}

// Apply the Google services plugin only once the Firebase config file exists,
// so the app still builds before the Firebase project is set up.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
