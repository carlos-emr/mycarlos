//! The real myCarlos executable, started as the AI helper's model process through the app's own
//! launcher and sandbox, running llama.cpp on a tiny model this test writes: no download, no
//! weights from anywhere. It proves the engine loads a GGUF file the way the app hands it over
//! (Linux: a sealed memfd; Windows: by path, writers denied, in the AppContainer), reads the
//! prompt, and samples a summary under the grammar.
//!
//! The model is built so that its answers do not depend on the processor: its final norm is
//! zero, so every token scores the same and greedy sampling takes the first allowed one in
//! vocabulary order. The vocabulary starts with `"` then `a`: each summary sentence is
//! `{"text":"a","quote":"a"}`, as many as the grammar allows.
#![cfg(any(target_os = "linux", windows))]

use mycarlos_tauri_poc_lib::model_engine_testing::ModelRunner;

/// A GGUF version 3 file, written by hand: its key/value pairs, then its F32 tensors.
struct Gguf {
    kv: Vec<u8>,
    kv_count: u64,
    tensors: Vec<(String, Vec<u64>, Vec<f32>)>,
}

const ALIGN: usize = 32;

fn string(out: &mut Vec<u8>, text: &str) {
    out.extend((text.len() as u64).to_le_bytes());
    out.extend(text.as_bytes());
}

impl Gguf {
    fn new() -> Self {
        Self {
            kv: Vec::new(),
            kv_count: 0,
            tensors: Vec::new(),
        }
    }

    fn key(&mut self, key: &str, kind: u32) {
        string(&mut self.kv, key);
        self.kv.extend(kind.to_le_bytes());
        self.kv_count += 1;
    }

    fn u32(&mut self, key: &str, value: u32) {
        self.key(key, 4);
        self.kv.extend(value.to_le_bytes());
    }

    fn f32(&mut self, key: &str, value: f32) {
        self.key(key, 6);
        self.kv.extend(value.to_le_bytes());
    }

    fn text(&mut self, key: &str, value: &str) {
        self.key(key, 8);
        string(&mut self.kv, value);
    }

    fn strings(&mut self, key: &str, values: &[String]) {
        self.key(key, 9);
        self.kv.extend(8u32.to_le_bytes());
        self.kv.extend((values.len() as u64).to_le_bytes());
        for value in values {
            string(&mut self.kv, value);
        }
    }

    fn floats(&mut self, key: &str, values: &[f32]) {
        self.key(key, 9);
        self.kv.extend(6u32.to_le_bytes());
        self.kv.extend((values.len() as u64).to_le_bytes());
        for value in values {
            self.kv.extend(value.to_le_bytes());
        }
    }

    fn ints(&mut self, key: &str, values: &[i32]) {
        self.key(key, 9);
        self.kv.extend(5u32.to_le_bytes());
        self.kv.extend((values.len() as u64).to_le_bytes());
        for value in values {
            self.kv.extend(value.to_le_bytes());
        }
    }

    /// A tensor of `dims` (ggml order, fastest first), filled by `fill`.
    fn tensor(&mut self, name: &str, dims: &[u64], fill: impl FnMut() -> f32) {
        let count = dims.iter().product::<u64>() as usize;
        let data = std::iter::repeat_with(fill).take(count).collect();
        self.tensors.push((name.to_owned(), dims.to_vec(), data));
    }

    fn bytes(&self) -> Vec<u8> {
        let mut out = b"GGUF".to_vec();
        out.extend(3u32.to_le_bytes());
        out.extend((self.tensors.len() as u64).to_le_bytes());
        out.extend(self.kv_count.to_le_bytes());
        out.extend(&self.kv);
        let mut offset = 0usize;
        for (name, dims, data) in &self.tensors {
            string(&mut out, name);
            out.extend((dims.len() as u32).to_le_bytes());
            for dim in dims {
                out.extend(dim.to_le_bytes());
            }
            out.extend(0u32.to_le_bytes()); // F32
            out.extend((offset as u64).to_le_bytes());
            offset += (data.len() * 4).div_ceil(ALIGN) * ALIGN;
        }
        out.resize(out.len().div_ceil(ALIGN) * ALIGN, 0);
        for (_, _, data) in &self.tensors {
            let start = out.len();
            for value in data {
                out.extend(value.to_le_bytes());
            }
            out.resize(start + (out.len() - start).div_ceil(ALIGN) * ALIGN, 0);
        }
        out
    }
}

/// A one-layer llama-architecture model, 64 wide, with a byte vocabulary: `"`, `a`, every
/// other byte, then unknown, start and end. Weights are small pseudo-random numbers made here.
fn tiny_model() -> Vec<u8> {
    const EMBED: u64 = 64;
    const FEED: u64 = 128;
    const HEADS: u32 = 4;
    let mut bytes: Vec<u8> = vec![b'"', b'a'];
    bytes.extend((0u8..=255).filter(|byte| !matches!(byte, b'"' | b'a')));
    let mut tokens: Vec<String> = bytes.iter().map(|byte| format!("<0x{byte:02X}>")).collect();
    let mut kinds = vec![6i32; tokens.len()];
    for (special, kind) in [("<unk>", 2), ("<s>", 3), ("</s>", 3)] {
        tokens.push(special.to_owned());
        kinds.push(kind);
    }
    let vocab = tokens.len() as u64;
    let mut gguf = Gguf::new();
    gguf.text("general.architecture", "llama");
    gguf.text("general.name", "FAKE tiny model");
    gguf.u32("llama.context_length", 8_192);
    gguf.u32("llama.embedding_length", EMBED as u32);
    gguf.u32("llama.block_count", 1);
    gguf.u32("llama.feed_forward_length", FEED as u32);
    gguf.u32("llama.attention.head_count", HEADS);
    gguf.u32("llama.attention.head_count_kv", HEADS);
    gguf.u32("llama.rope.dimension_count", EMBED as u32 / HEADS);
    gguf.f32("llama.attention.layer_norm_rms_epsilon", 1e-5);
    gguf.text("tokenizer.ggml.model", "llama");
    gguf.strings("tokenizer.ggml.tokens", &tokens);
    gguf.floats("tokenizer.ggml.scores", &vec![0.0; tokens.len()]);
    gguf.ints("tokenizer.ggml.token_type", &kinds);
    gguf.u32("tokenizer.ggml.unknown_token_id", vocab as u32 - 3);
    gguf.u32("tokenizer.ggml.bos_token_id", vocab as u32 - 2);
    gguf.u32("tokenizer.ggml.eos_token_id", vocab as u32 - 1);
    gguf.text(
        "tokenizer.chat_template",
        "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + \
         message['content'] + '<|im_end|>' + '\\n'}}{% endfor %}{% if add_generation_prompt %}\
         {{ '<|im_start|>assistant\\n' }}{% endif %}",
    );
    // A fixed-seed xorshift: small weights, the same on every run.
    let mut state: u32 = 0x1234_5678;
    let mut weight = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state as f32 / u32::MAX as f32 - 0.5) * 0.1
    };
    gguf.tensor("token_embd.weight", &[EMBED, vocab], &mut weight);
    // Zero: every token scores the same (see the file's comment).
    gguf.tensor("output_norm.weight", &[EMBED], || 0.0);
    gguf.tensor("output.weight", &[EMBED, vocab], &mut weight);
    gguf.tensor("blk.0.attn_norm.weight", &[EMBED], || 1.0);
    for name in ["attn_q", "attn_k", "attn_v", "attn_output"] {
        gguf.tensor(
            &format!("blk.0.{name}.weight"),
            &[EMBED, EMBED],
            &mut weight,
        );
    }
    gguf.tensor("blk.0.ffn_norm.weight", &[EMBED], || 1.0);
    gguf.tensor("blk.0.ffn_gate.weight", &[EMBED, FEED], &mut weight);
    gguf.tensor("blk.0.ffn_up.weight", &[EMBED, FEED], &mut weight);
    gguf.tensor("blk.0.ffn_down.weight", &[FEED, EMBED], &mut weight);
    gguf.bytes()
}

/// The executable, which AppContainers may read and run on Windows, as the installer allows.
fn executable() -> &'static std::path::Path {
    let executable = std::path::Path::new(env!("CARGO_BIN_EXE_mycarlos-tauri-poc"));
    #[cfg(windows)]
    for path in [executable, executable.parent().unwrap()] {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .args(["/grant", "*S-1-15-2-1:(RX)"])
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "{}", path.display());
    }
    executable
}

/// Writes `bytes` as a model file in `dir`, readable by AppContainers on Windows as the install
/// step makes the model folder.
fn model_file(dir: &std::path::Path, bytes: &[u8]) -> std::path::PathBuf {
    let path = dir.join("FAKE-tiny-model.gguf");
    std::fs::write(&path, bytes).unwrap();
    #[cfg(windows)]
    {
        let status = std::process::Command::new("icacls")
            .arg(&path)
            .args(["/grant", "*S-1-15-2-1:(R)"])
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }
    path
}

#[test]
fn the_real_engine_loads_the_model_as_handed_over_and_summarizes_under_the_grammar() {
    let dir = tempfile::tempdir().unwrap();
    let model = model_file(dir.path(), &tiny_model());
    let runner = ModelRunner::start(executable(), &model).unwrap_or_else(|error| panic!("{error}"));
    let (sentences, last_page) = runner
        .summarize(
            "en",
            &[
                (0, "FAKE: a blood test was done."),
                (1, "FAKE: a second page."),
            ],
        )
        .unwrap();
    assert_eq!(last_page, 1);
    assert_eq!(sentences.len(), 6, "{sentences:?}");
    for (text, quote) in &sentences {
        assert_eq!((text.as_str(), quote.as_str()), ("a", "a"));
    }
    // No grammar for an explanation: it stops at its cap, all of it kept.
    let text = runner
        .explain("en", "blood test", "FAKE: a blood test was done.")
        .unwrap();
    assert!(!text.is_empty() && text.chars().all(|c| c == '"'), "{text}");
    runner.stop();
}

#[test]
fn a_model_file_that_is_not_a_model_ends_the_helper_before_it_greets() {
    let dir = tempfile::tempdir().unwrap();
    let model = model_file(dir.path(), b"GGUF FAKE but not a model");
    let error = ModelRunner::start(executable(), &model)
        .err()
        .expect("refused");
    assert!(error.contains("ended before its hello"), "{error}");
}

/// A real model from the environment over FAKE documents, for trying a model by hand:
/// `MYCARLOS_TEST_MODEL` names a GGUF file, `MYCARLOS_TEST_DOCS` a folder of FAKE `.txt`
/// documents, `MYCARLOS_TEST_LANG` the summaries' language (default `en`). Prints each answer
/// and its time. Never in CI: run with `--ignored --nocapture`.
#[test]
#[ignore = "needs a real model file; run by hand with --ignored --nocapture"]
fn a_real_model_from_the_environment_summarizes_fake_documents() {
    use std::time::Instant;
    let variable = |name: &str| {
        std::path::PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name}")))
    };
    let (model, docs) = (
        variable("MYCARLOS_TEST_MODEL"),
        variable("MYCARLOS_TEST_DOCS"),
    );
    let lang = std::env::var("MYCARLOS_TEST_LANG").unwrap_or_else(|_| "en".to_owned());
    let started = Instant::now();
    let runner = ModelRunner::start(executable(), &model).unwrap_or_else(|error| panic!("{error}"));
    println!("started in {:.1} s", started.elapsed().as_secs_f64());
    let mut names: Vec<_> = std::fs::read_dir(&docs)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "txt"))
        .collect();
    names.sort();
    for path in names {
        let text = std::fs::read_to_string(&path).unwrap();
        let asked = Instant::now();
        let answer = runner.summarize(&lang, &[(0, &text)]);
        println!(
            "\n== {} ({:.1} s)",
            path.file_name().unwrap().to_string_lossy(),
            asked.elapsed().as_secs_f64()
        );
        match answer {
            Ok((sentences, _)) => {
                for (text, quote) in sentences {
                    println!("- {text}\n    [{quote}]");
                }
            }
            Err(error) => println!("  failed: {error}"),
        }
    }
    let asked = Instant::now();
    let explained = runner.explain(
        &lang,
        "ejection fraction",
        "An echocardiogram on 2026-10-16 showed an ejection fraction of 35%, unchanged from 2024.",
    );
    println!(
        "\n== explain ({:.1} s): {explained:?}",
        asked.elapsed().as_secs_f64()
    );
    runner.stop();
}
