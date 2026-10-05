// Root build file. Plugin versions are declared once here (with apply
// false) so both modules below can apply the same plugins without
// re-specifying a version -- standard multi-module Gradle Kotlin DSL setup.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("com.android.library") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
