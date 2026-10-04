// Android library module -- drop this folder into the host app's project
// (e.g. as ":netplanning-telemetry-sdk" in settings.gradle.kts) and add
// `implementation(project(":netplanning-telemetry-sdk"))` to the host app's
// own build.gradle.kts.
//
// NOT compiled or run in the environment this was written in -- there is no
// Android SDK available there (see README.md, "Verification status"). Written
// against stable, long-established Android APIs; a real Android build should
// still be the first thing done with it, before it goes near a pilot device.

// No versions pinned on the two plugins below -- this assumes the host
// project's root build.gradle.kts already manages them (via `apply false`
// there), which is standard for any existing multi-module Android app and
// should already be true of Nepal Telecom's project. If not, add matching
// versions here or in the root's plugin management block first.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "np.nepaltelecom.telemetry"
    compileSdk = 34

    defaultConfig {
        minSdk = 26 // Android 8.0 -- covers modern getAllCellInfo()/SignalStrength behavior cleanly
        targetSdk = 34
        consumerProguardFiles("consumer-rules.pro")
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
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.work:work-runtime-ktx:2.9.1")           // scheduled, constrained upload
    implementation("androidx.security:security-crypto:1.1.0-alpha06") // encrypted pseudonymous-ID storage
    implementation("com.google.android.gms:play-services-location:21.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
