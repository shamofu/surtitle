use std::{env, fs, path::PathBuf};

fn main() {
    let manifest_path = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../native/runtime-windows-x64.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    let model = manifest["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["id"] == "silero-vad")
        .expect("Silero VAD must be pinned in the native runtime manifest");
    let version = model["version"].as_str().unwrap();
    let url = model["url"].as_str().unwrap();
    let sha256 = model["sha256"].as_str().unwrap();
    assert!(version
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.'));
    assert!(url.starts_with("https://") && url.is_ascii());
    assert!(sha256.len() == 64 && sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let filename = format!("silero-v{version}-{sha256}.onnx");
    let constants = [
        ("SILERO_MODEL_VERSION", version),
        ("SILERO_MODEL_URL", url),
        ("SILERO_MODEL_SHA256", sha256),
        ("SILERO_MODEL_FILENAME", filename.as_str()),
    ]
    .map(|(name, value)| format!("pub const {name}: &str = {value:?};\n"))
    .concat();
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("silero_model.rs"),
        constants,
    )
    .unwrap();
}
