// RECOVERED DRAFT ONLY: never compiled or run; workspace entered ext4 emergency_ro.
// Batch512 matches actual878d model_helper.rs:69; initial requested256 did not.
// Private constructor-only diagnostic. No tokenization, prompt, decode or generation.
// Reuses the pinned native archives; does not change the production helper or sandbox.
#include "llama.h"
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <csignal>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

static constexpr char MODEL[] = "PRIVATE_UNSET";
static constexpr uint64_t MODEL_BYTES = 3013027808ULL;
static constexpr uint64_t DATA_LIMIT = MODEL_BYTES + 2ULL * 1024 * 1024 * 1024;
static std::atomic<int> capture_stage{0}; // Only constructor WARN/ERROR messages, never model-load logs.
static std::atomic_flag log_lock = ATOMIC_FLAG_INIT;
static char native_log[4096]{};
static size_t log_used = 0;
static bool log_truncated = false;

static void logger(enum ggml_log_level level, const char * text, void *) {
    const int stage = capture_stage.load(std::memory_order_relaxed);
    if (!stage || !text || (level != GGML_LOG_LEVEL_ERROR && level != GGML_LOG_LEVEL_WARN)) return;
    if (log_lock.test_and_set(std::memory_order_acquire)) return;
    const char * label = stage == 1 ? "target: " : "draft: ";
    for (const char * s = label; *s; ++s) {
        if (log_used + 1 < sizeof(native_log)) native_log[log_used++] = *s;
        else log_truncated = true;
    }
    for (size_t i = 0; text[i] && i < 4096; ++i) {
        if (log_used + 1 < sizeof(native_log)) native_log[log_used++] = text[i];
        else log_truncated = true;
    }
    native_log[log_used] = '\0';
    log_lock.clear(std::memory_order_release);
}

struct Memory { long data_kib = -1, size_kib = -1, rss_kib = -1; };
static Memory memory() {
    Memory result;
    FILE * file = std::fopen("/proc/self/status", "r");
    if (!file) return result;
    char line[256];
    for (unsigned rows = 0; rows < 256 && std::fgets(line, sizeof(line), file); ++rows) {
        if (std::strncmp(line, "VmData:", 7) == 0) std::sscanf(line + 7, "%ld", &result.data_kib);
        if (std::strncmp(line, "VmSize:", 7) == 0) std::sscanf(line + 7, "%ld", &result.size_kib);
        if (std::strncmp(line, "VmRSS:", 6) == 0) std::sscanf(line + 6, "%ld", &result.rss_kib);
    }
    std::fclose(file);
    return result;
}
static void print_memory(const char * name, Memory m) {
    std::printf("\"%s\":{\"dataKiB\":%ld,\"sizeKiB\":%ld,\"rssKiB\":%ld},", name, m.data_kib, m.size_kib, m.rss_kib);
}
static void print_json_string(const char * s) {
    std::putchar('"');
    for (const unsigned char * p = reinterpret_cast<const unsigned char *>(s); *p; ++p) {
        if (*p == '"' || *p == '\\') { std::putchar('\\'); std::putchar(*p); }
        else if (*p < 32 || *p >= 127) std::printf("\\u%04x", unsigned(*p));
        else std::putchar(*p);
    }
    std::putchar('"');
}
static bool metadata(const llama_model * model, const char * key, const char * wanted) {
    char value[64]{};
    const int n = llama_model_meta_val_str(model, key, value, sizeof(value));
    return n >= 0 && size_t(n) < sizeof(value) && std::strcmp(value, wanted) == 0;
}
static void timed_out(int) { _exit(124); }

int main(int argc, char ** argv) {
    if (argc != 2 || std::strcmp(argv[1], "--constructor-only") != 0) return 64;
    std::signal(SIGALRM, timed_out);
    alarm(45); // Root's separate admission and outer cleanup remain required.
    struct stat st{};
    if (stat(MODEL, &st) || !S_ISREG(st.st_mode) || uint64_t(st.st_size) != MODEL_BYTES) return 65;
    const rlimit data_limit{DATA_LIMIT, DATA_LIMIT};
    const rlimit no_core{0, 0};
    if (setrlimit(RLIMIT_DATA, &data_limit) || setrlimit(RLIMIT_CORE, &no_core)) return 66;
    rlimit actual{};
    if (getrlimit(RLIMIT_DATA, &actual) || actual.rlim_cur != DATA_LIMIT || actual.rlim_max != DATA_LIMIT) return 67;
    llama_log_set(logger, nullptr);
    ggml_log_set(logger, nullptr);
    llama_backend_init();
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = 0;
    mp.load_mode = LLAMA_LOAD_MODE_NONE;
    mp.load_mtp = true;
    const auto began = std::chrono::steady_clock::now();
    llama_model * model = llama_model_load_from_file(MODEL, mp);
    if (!model) {
        std::puts("{\"stage\":\"model_load\",\"modelLoaded\":false,\"generationInvoked\":false}");
        llama_backend_free();
        return 68;
    }
    const bool valid = metadata(model, "general.architecture", "qwen35")
        && metadata(model, "qwen35.nextn_predict_layers", "1")
        && metadata(model, "qwen35.block_count", "33")
        && llama_model_n_embd(model) == 2560 && llama_model_n_layer(model) == 32
        && llama_model_n_layer_nextn(model) == 1;
    if (!valid) {
        std::puts("{\"stage\":\"model_metadata\",\"metadataMatched\":false,\"generationInvoked\":false}");
        llama_model_free(model); llama_backend_free(); return 69;
    }
    const Memory before = memory();
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = 8192; cp.n_batch = 512; cp.n_ubatch = 512;
    cp.n_threads = 3; cp.n_threads_batch = 3; cp.n_seq_max = 1; cp.n_rs_seq = 1;
    capture_stage.store(1, std::memory_order_relaxed);
    const auto target_start = std::chrono::steady_clock::now();
    llama_context * target = llama_init_from_model(model, cp);
    const auto target_end = std::chrono::steady_clock::now();
    capture_stage.store(0, std::memory_order_relaxed);
    const Memory after_target = memory();
    llama_context * draft = nullptr;
    const auto draft_start = std::chrono::steady_clock::now();
    if (target) {
        cp.n_ubatch = 64;
        cp.n_rs_seq = 0;
        cp.ctx_type = LLAMA_CONTEXT_TYPE_MTP;
        capture_stage.store(2, std::memory_order_relaxed);
        draft = llama_init_from_model(model, cp);
        capture_stage.store(0, std::memory_order_relaxed);
    }
    const auto draft_end = std::chrono::steady_clock::now();
    const Memory after_draft = memory();
    const bool target_ok = target != nullptr, draft_ok = draft != nullptr;
    if (draft) llama_free(draft);
    if (target) llama_free(target);
    llama_model_free(model);
    llama_backend_free();
    char final_log[sizeof(native_log)];
    while (log_lock.test_and_set(std::memory_order_acquire)) {}
    std::memcpy(final_log, native_log, sizeof(final_log));
    const bool truncated = log_truncated;
    log_lock.clear(std::memory_order_release);
    const auto ms = [](auto a, auto b) { return std::chrono::duration_cast<std::chrono::milliseconds>(b - a).count(); };
    std::printf("{\"schema\":\"mtp-constructor-only-v1\",\"modelLoaded\":true,\"metadataMatched\":true,"
        "\"targetCreated\":%s,\"draftAttempted\":%s,\"draftCreated\":%s,"
        "\"loadMs\":%lld,\"targetMs\":%lld,\"draftMs\":%lld,\"dataLimitBytes\":%llu,"
        "\"generationInvoked\":false,\"clinicalInputsRead\":false,\"productionSandboxReproduced\":false,",
        target_ok ? "true" : "false", target_ok ? "true" : "false", draft_ok ? "true" : "false",
        (long long) ms(began, target_start), (long long) ms(target_start, target_end),
        (long long) ms(draft_start, draft_end), (unsigned long long) DATA_LIMIT);
    print_memory("beforeTarget", before); print_memory("afterTarget", after_target); print_memory("afterDraft", after_draft);
    std::printf("\"nativeLogTruncated\":%s,\"nativeConstructorLog\":", truncated ? "true" : "false");
    print_json_string(final_log); std::puts("}"); std::fflush(stdout);
    alarm(0);
    return !target_ok ? 2 : !draft_ok ? 3 : 0;
}
