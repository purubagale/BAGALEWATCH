// Minimal demo/test-harness app -- NOT the pilot's real front end (that is
// a separate effort, by this project's own task split). This exists only
// so netplanning-telemetry-sdk is something a real Android Studio build
// can compile, install, and exercise with actual button presses, on a
// real device, before it goes anywhere near Nepal Telecom's own app.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "np.nepaltelecom.telemetry.demo"
    compileSdk = 34

    defaultConfig {
        applicationId = "np.nepaltelecom.telemetry.demo"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
}

// Apply the Google services plugin only once the Firebase config file exists,
// so the app still builds before the Firebase project is set up.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}
