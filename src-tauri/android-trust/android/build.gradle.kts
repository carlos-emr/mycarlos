import java.io.File

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// The platform verifier's Kotlin half (rustls-platform-verifier-android) is published as a Maven
// artifact (org.rustls:rustls-platform-verifier), not on Maven Central. The URL names a COMMIT of
// the archive branch, not the moving branch, and the bytes are pinned too: the patcher
// (scripts/configure-android-security.mjs) writes a Gradle dependency-verification file with the
// SHA-256 of the .aar and .pom for this one component. It is fetched from its own repository and from nowhere else,
// and only that group may come from there, so that repository can never serve another artifact
// (a dependency-confusion door shut). Its version is the one in Cargo.lock: the native crate and
// this component must be identical. The repository is added to every project of the build, not
// to this library alone: the app module resolves the dependency, and a repository declared in a
// library is not searched for the app's classpath (CI's first run: "Could not find
// rustls:rustls-platform-verifier").
rootProject.allprojects {
    repositories {
        exclusiveContent {
            forRepository {
                maven {
                    url = uri("https://github.com/rustls/rustls-platform-verifier/raw/1aa691352a5e0c215210dfc9a3c2f2078639dc91/android-release-support/maven/")
                }
            }
            filter {
                includeGroup("org.rustls")
            }
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
    implementation("org.rustls:rustls-platform-verifier:$verifierVersion")
}
