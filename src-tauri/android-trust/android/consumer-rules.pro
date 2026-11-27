# The plugin entry, and the verifier's Kotlin half: R8 cannot see the JNI calls into it, so it
# must be kept by name (the crate's own instruction).
-keep class ca.carlos.mycarlos.trust.PortalTrustPlugin { *; }
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
