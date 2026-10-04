pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "nepal-telemetry-project"

// The real deliverable is the SDK module -- this file (and the minimal
// :app demo module it wires in) exists only so the SDK is something a
// real Android Studio build can actually compile and run, not just read.
// See netplanning-telemetry-sdk/README.md for the SDK itself, and the
// root README.md in this project for how the two modules relate.
include(":app")
include(":netplanning-telemetry-sdk")
