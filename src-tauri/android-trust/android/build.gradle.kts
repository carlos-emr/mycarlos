import java.io.File

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// The platform verifier's Kotlin half (rustls-platform-verifier-android) is published as a Maven
// artifact, not on Maven Central. It is fetched from its own repository and from nowhere else,
// and only that group may come from there, so that repository can never serve another artifact
// (a dependency-confusion door shut). Its version is the one in Cargo.lock: the native crate and
// this component must be identical.
repositories {
    exclusiveContent {
        forRepository {
            maven {
                url = uri("https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/")
            }
        }
        filter {
            includeGroup("rustls")
        }
    }
}

val verifierVersion: String = run {
    // src-tauri/android-trust/android -> src-tauri/Cargo.lock
    val lock = File(projectDir, "../../Cargo.lock")
    val lines = lock.readLines()
    val name = lines.indexOfFirst { it.trim() == "name = \"rustls-platform-verifier-android\"" }
    require(name >= 0) { "rustls-platform-verifier-android is not in ${lock.path}" }
    lines.drop(name + 1)
        .firstOrNull { it.trimStart().startsWith("version = ") }
        ?.substringAfter('"')
        ?.substringBefore('"')
        ?.takeIf { it.isNotEmpty() }
        ?: error("no version for rustls-platform-verifier-android in ${lock.path}")
}

android {
    namespace = "ca.carlos.mycarlos.trust"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
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
    implementation(project(":tauri-android"))
    implementation("rustls:rustls-platform-verifier:$verifierVersion")
}
