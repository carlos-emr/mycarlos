use std::path::Path;
use std::process::Command;

const HELPER: &str = env!("CARGO_BIN_EXE_split-helper");

#[test]
fn binds_variant_final_helper() {
    println!("EMBEDDED_HELPER={}", HELPER);
    let expected_helper = std::env::var("TOY_EXPECT_HELPER").expect("runtime helper expectation");
    let expected_variant = std::env::var("TOY_EXPECT_VARIANT").expect("runtime variant expectation");
    assert_eq!(Path::new(HELPER), Path::new(&expected_helper));
    let output = Command::new(HELPER).output().expect("run embedded helper");
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), format!("{}\n", expected_variant));
}
