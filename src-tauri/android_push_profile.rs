//! Shared build admission predicate. Feature OFF rejects residual ON artifacts rather than
//! silently packaging an active Firebase service with the native owner compiled out.
pub struct Files {
    pub any_source: bool,
    pub sources_match: bool,
    pub client_config: bool,
    pub icon: bool,
}
pub fn consistent(enabled: bool, manifest: &str, gradle: &str, files: Files) -> bool {
    // Reject all recognizable unmanaged Firebase coordinates/BOM/catalog references. An
    // arbitrary opaque catalog alias still requires the separately reviewed resolved graph.
    let unmanaged = gradle.replace("com.google.firebase:firebase-messaging:26.0.1", "");
    if !enabled {
        return !gradle.to_ascii_lowercase().contains("firebase")
            && !manifest.contains("MYCARLOS_PUSH")
            && !manifest.contains("com.google.firebase")
            && !manifest.contains("firebase_messaging")
            && !manifest.contains("ca.carlos.mycarlos.push")
            && !gradle.contains("firebase-messaging")
            && !gradle.contains("firebase.messaging")
            && !files.any_source
            && !files.client_config
            && !files.icon;
    }
    manifest.contains("<!-- MYCARLOS_PUSH_BEGIN -->")
        && manifest.contains("ca.carlos.mycarlos.push.ReadyMessagingService")
        && manifest.contains("firebase_messaging_auto_init_enabled\" android:value=\"false\"")
        && manifest.contains("firebase_analytics_collection_enabled\" android:value=\"false\"")
        && manifest.contains("android.permission.POST_NOTIFICATIONS")
        && gradle
            .matches("com.google.firebase:firebase-messaging:26.0.1")
            .count()
            == 1
        && gradle.matches("firebase-messaging").count() == 1
        && !unmanaged.to_ascii_lowercase().contains("firebase")
        && files.sources_match
        && files.client_config
        && files.icon
}
#[cfg(test)]
mod tests {
    use super::*;
    const ON: &str = "<!-- MYCARLOS_PUSH_BEGIN --> ca.carlos.mycarlos.push.ReadyMessagingService firebase_messaging_auto_init_enabled\" android:value=\"false\" firebase_analytics_collection_enabled\" android:value=\"false\" android.permission.POST_NOTIFICATIONS";
    const GRADLE: &str = "com.google.firebase:firebase-messaging:26.0.1";
    fn files(on: bool) -> Files {
        Files {
            any_source: on,
            sources_match: on,
            client_config: on,
            icon: on,
        }
    }
    #[test]
    fn fresh_off_build_is_admitted() {
        assert!(consistent(
            false,
            "<application/>",
            "plugins {}",
            files(false)
        ));
    }
    #[test]
    fn on_to_off_reuse_fails_closed() {
        assert!(!consistent(false, ON, GRADLE, files(true)));
    }
    #[test]
    fn partial_stale_artifacts_also_fail_off() {
        assert!(!consistent(false, "<application/>", GRADLE, files(false)));
        assert!(!consistent(
            false,
            "<application/>",
            "",
            Files {
                any_source: true,
                ..files(false)
            }
        ));
        assert!(!consistent(
            false,
            "<application/>",
            "",
            Files {
                client_config: true,
                ..files(false)
            }
        ));
    }
    #[test]
    fn on_requires_matching_sources_config_and_dependency() {
        assert!(consistent(true, ON, GRADLE, files(true)));
        assert!(!consistent(
            true,
            ON,
            GRADLE,
            Files {
                sources_match: false,
                ..files(true)
            }
        ));
        assert!(!consistent(true, ON, "", files(true)));
        for platform in [
            "implementation(platform(\"com.google.firebase:firebase-bom:35.1.0\"))",
            "implementation(enforcedPlatform(\"com.google.firebase:firebase-bom:35.1.0\"))",
            "implementation(platform(libs.firebase.bom))",
            "implementation(enforcedPlatform(libs.firebaseBom))",
        ] {
            assert!(!consistent(
                true,
                ON,
                &format!("{GRADLE} {platform}"),
                files(true)
            ));
        }
        assert!(!consistent(
            true,
            ON,
            GRADLE,
            Files {
                client_config: false,
                ..files(true)
            }
        ));
    }
}
