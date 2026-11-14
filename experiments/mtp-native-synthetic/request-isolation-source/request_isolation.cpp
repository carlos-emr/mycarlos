// SYNTHETIC SOURCE ONLY: not compiled or run by Agent3; Root admission required.
// Batch512 matches actual878d model_helper.rs:69; initial requested256 did not.
// Non-clinical synthetic prefill513 + K1 mechanics only; no production safety or speed claim.
// Reuses the pinned native archives; does not change the production helper or sandbox.
#include "llama.h"
#include "wrapper_common.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <csignal>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

static constexpr char MODEL[] = "REPLACE_WITH_ROOT_ADMITTED_GGUF";
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
    const char * label = stage == 1 ? "target: " : stage == 2 ? "draft: " : "synthetic: ";
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

// Source only: no compile/model/decode performed by Agent3.
// Include with the constructor V3 fixture and wrapper_common.h; same pinned archives.
// Greedy policy excludes EOG to keep this finite mechanical fixture moving.
struct RequestProof {
    std::vector<llama_token> tokens; // <=8 synthetic answer IDs, never printed.
    uint64_t hash = 0;
    Memory before_wrapper_drop;
    llama_pos target_pos = -1, draft_pos = -1;
};
static uint64_t token_hash(const std::vector<llama_token> & tokens) {
    // Diagnostic FNV-1a64 over explicit little-endian token IDs then count.
    // Exact vectors are ALSO compared; this hash is not a cryptographic proof.
    uint64_t h=14695981039346656037ULL;
    for(llama_token t:tokens) for(unsigned i=0;i<4;++i) { h^=uint8_t(uint32_t(t)>>(8*i));h*=1099511628211ULL; }
    const uint64_t count=tokens.size();
    for(unsigned i=0;i<8;++i) { h^=uint8_t(count>>(8*i));h*=1099511628211ULL; }
    return h;
}

static bool synthetic_decode_called = false;
static bool synthetic_k1(llama_model * model, llama_context * target, llama_context * draft, RequestProof & proof) {
    proof = RequestProof{};
    const auto * vocab = llama_model_get_vocab(model);
    const int n_vocab = llama_vocab_n_tokens(vocab);
    const bool causal = llama_get_causal_attn(draft);
    std::printf("{\"stage\":\"synthetic_config\",\"draftCausalActual\":%s,\"targetBatch\":%u,\"targetMicro\":%u,\"draftBatch\":%u,\"draftMicro\":%u,\"clinicalInputsRead\":false}\n",
        causal ? "true":"false", llama_n_batch(target), llama_n_ubatch(target), llama_n_batch(draft), llama_n_ubatch(draft));
    std::fflush(stdout);
    if (!causal || llama_n_batch(target)!=512 || llama_n_batch(draft)!=512 ||
        llama_n_ubatch(target)!=512 || llama_n_ubatch(draft)!=64 || n_vocab<=0) return false;
    struct Resources {
        llama_rs_mtp_speculative * spec = nullptr;
        llama_batch batch{};
        ~Resources() { if (spec) llama_rs_mtp_speculative_free(spec); if (batch.token) llama_batch_free(batch); }
    } r;
    // Init BEFORE any decode: common constructor enables unmasked nextn hidden rows.
    r.spec = llama_rs_mtp_speculative_init(target,draft,1,0,0.0f);
    if (!r.spec) return false;
    r.batch=llama_batch_init(512,0,1);
    if (!r.batch.token || !r.batch.pos || !r.batch.n_seq_id || !r.batch.seq_id || !r.batch.logits) return false;
    const auto fail=[](const char * stage) { std::printf("{\"stage\":\"%s\",\"syntheticPassed\":false}\n",stage);std::fflush(stdout);return false; };
    const auto fill=[&](const llama_token * tokens,int count,llama_pos pos,bool all_logits) {
        r.batch.n_tokens=count;
        for(int i=0;i<count;++i) {
            r.batch.token[i]=tokens[i];r.batch.pos[i]=pos+i;
            r.batch.n_seq_id[i]=1;r.batch.seq_id[i][0]=0;
            r.batch.logits[i]=all_logits || i==count-1;
        }
    };
    const auto posmax=[](llama_context * ctx) { return llama_memory_seq_pos_max(llama_get_memory(ctx),0); };
    const auto trim=[&](llama_context * ctx,llama_pos end) {
        return llama_memory_seq_rm(llama_get_memory(ctx),0,end,-1) && posmax(ctx)==end-1;
    };
    const auto pick=[&](const float * logits,llama_token & token) {
        if (!logits) return false;
        float best=-std::numeric_limits<float>::infinity();token=LLAMA_TOKEN_NULL;
        for(int i=0;i<n_vocab;++i) {
            if(std::isnan(logits[i])) return false;
            if(!llama_vocab_is_eog(vocab,i) && std::isfinite(logits[i]) && (token==LLAMA_TOKEN_NULL || logits[i]>best)) {
                best=logits[i];token=i;
            }
        }
        return token!=LLAMA_TOKEN_NULL;
    };
    // Fixed non-clinical literal; no filesystem prompt, text rendering or token IDs in output.
    llama_token seed[64];
    static constexpr char text[]=" Synthetic arithmetic calibration: one two three four. ";
    const int seed_count=llama_tokenize(vocab,text,sizeof(text)-1,seed,64,false,false);
    if(seed_count<=0 || seed_count>64) return fail("synthetic_tokenize");
    for(int i=0;i<seed_count;++i) if(seed[i]<0 || seed[i]>=n_vocab || llama_vocab_is_eog(vocab,seed[i])) return fail("synthetic_seed");
    std::vector<llama_token> history(513);
    for(size_t i=0;i<history.size();++i) history[i]=seed[i%seed_count];
    int prefill_rows=0,process_rows=0,logical_calls=0,expected_micro_chunks=0;
    for(int start=0;start<513;start+=512) {
        const int count=std::min(512,513-start);fill(history.data()+start,count,start,false);
        synthetic_decode_called=true;
        if(llama_decode(target,r.batch)!=0) return fail("target_prefill");
        prefill_rows+=count;
        if(llama_rs_mtp_speculative_process(r.spec,&r.batch)!=LLAMA_RS_STATUS_OK) return fail("draft_prefill_process");
        process_rows+=count;++logical_calls;expected_micro_chunks+=(count+63)/64;
        if(posmax(target)!=start+count-1 || posmax(draft)!=start+count-1) return fail("prefill_positions");
        std::printf("{\"stage\":\"synthetic_prefill\",\"logicalRows\":%d,\"targetRowsTotal\":%d,\"processRowsTotal\":%d,\"targetPosMax\":%d,\"draftPosMax\":%d,\"expectedMicroChunksSourceDerived\":%d,\"internalMicroTraceObserved\":false}\n",
            count,prefill_rows,process_rows,int(posmax(target)),int(posmax(draft)),(count+63)/64);
        std::fflush(stdout);
    }
    if(prefill_rows!=513 || process_rows!=513 || logical_calls!=2 || expected_micro_chunks!=9) return fail("all_prefill_rows");
    if(llama_rs_mtp_speculative_begin(r.spec,history.data(),history.size())!=LLAMA_RS_STATUS_OK) return fail("spec_begin");
    llama_token pending=LLAMA_TOKEN_NULL;
    if(!pick(llama_get_logits_ith(target,-1),pending)) return fail("prefill_pick");
    llama_pos position=513;int committed=0,accepted_total=0,natural_rejections=0,forced_truncations=0;
    bool next_decode_realized_forced_rollback=false;
    for(int round=0;round<4;++round) {
        llama_token proposal=LLAMA_TOKEN_NULL;size_t drafted=0;
        const auto rc=llama_rs_mtp_speculative_draft(r.spec,position,pending,history.data(),history.size(),&proposal,1,&drafted);
        std::printf("{\"stage\":\"synthetic_draft_status\",\"round\":%d,\"status\":%d,\"proposalCount\":%zu}\n",round,int(rc),drafted);
        std::fflush(stdout);
        if(rc!=LLAMA_RS_STATUS_OK || drafted!=1 || proposal<0 || proposal>=n_vocab) return fail("spec_draft_k1_empty_or_error");
        // Production clips EOG proposals; this bounded mechanics fixture fails explicitly.
        if(llama_vocab_is_eog(vocab,proposal)) return fail("draft_eog_not_exercised");
        // Matches production ordering: remove provisional draft id_last before verify/process.
        if(!trim(draft,position)) return fail("draft_provisional_trim");
        const llama_token submitted[2]={pending,proposal};fill(submitted,2,position,true);
        if(llama_decode(target,r.batch)!=0) return fail("target_verify_k1");
        if(round==1) next_decode_realized_forced_rollback=true;
        if(posmax(target)!=position+1) return fail("verify_position");
        llama_token oracle0=LLAMA_TOKEN_NULL,oracle1=LLAMA_TOKEN_NULL;
        // Copy decisions BEFORE any later target decode invalidates borrowed logits.
        if(!pick(llama_get_logits_ith(target,0),oracle0) || !pick(llama_get_logits_ith(target,1),oracle1)) return fail("verify_logits");
        if(llama_rs_mtp_speculative_process(r.spec,&r.batch)!=LLAMA_RS_STATUS_OK) return fail("verify_process");
        const bool natural_match=oracle0==proposal;
        const bool forced=round==0; // Explicit diagnostic prefix truncation, not a natural mismatch.
        const uint16_t accepted=(!forced && natural_match)?1:0;
        const llama_pos end=position+1+accepted;
        // Only ONE partial target rollback, depth exactly1, and only when needed.
        if(!accepted && !trim(target,end)) return fail("target_rollback_one");
        if(!trim(draft,end)) return fail("draft_accepted_trim");
        if(llama_rs_mtp_speculative_accept(r.spec,accepted)!=LLAMA_RS_STATUS_OK) return fail("spec_accept");
        history.push_back(pending);proof.tokens.push_back(pending);
        if(accepted) { history.push_back(proposal);proof.tokens.push_back(proposal); }
        committed+=1+accepted;accepted_total+=accepted;
        if(forced) ++forced_truncations;else if(!natural_match) ++natural_rejections;
        pending=accepted?oracle1:oracle0;position=end;
        if(committed>7 || size_t(position)!=history.size() || posmax(target)!=position-1 || posmax(draft)!=position-1) return fail("accepted_boundary");
        std::printf("{\"stage\":\"synthetic_round\",\"round\":%d,\"drafted\":1,\"verifiedRows\":2,\"accepted\":%u,\"naturalMatch\":%s,\"forcedPrefixTruncation\":%s,\"rollbackDepth\":%d,\"targetPosMax\":%d,\"draftPosMax\":%d,\"committedTokens\":%d}\n",
            round,unsigned(accepted),natural_match?"true":"false",forced?"true":"false",accepted?0:1,int(posmax(target)),int(posmax(draft)),committed);
        std::fflush(stdout);
    }
    // One final ordinary token realizes any final deferred recurrent rollback; <=8 commits.
    fill(&pending,1,position,false);
    if(llama_decode(target,r.batch)!=0 || llama_rs_mtp_speculative_process(r.spec,&r.batch)!=LLAMA_RS_STATUS_OK) return fail("final_pending_decode");
    proof.tokens.push_back(pending);
    ++committed;++position;
    if(committed>8 || posmax(target)!=position-1 || posmax(draft)!=position-1 || !next_decode_realized_forced_rollback) return fail("final_positions");
    std::printf("{\"stage\":\"synthetic_complete\",\"syntheticPassed\":true,\"targetPrefillRows\":%d,\"draftProcessPrefillRows\":%d,\"logicalPrefillCalls\":2,\"expectedMicroChunksSourceDerived\":9,\"internalMicroTraceObserved\":false,\"draftCausalActual\":true,\"k\":1,\"rounds\":4,\"committedTokens\":%d,\"acceptedDraftTokens\":%d,\"naturalRejections\":%d,\"forcedTruncations\":%d,\"fullAcceptanceCovered\":%s,\"rollbackAndNextDecodeCovered\":true,\"samplingPolicy\":\"greedy_non_eog_lower_id_ties\",\"clinicalInputsRead\":false,\"productionEogHandlingCovered\":false,\"productionGrammarValidated\":false,\"performanceClaim\":false}\n",
        prefill_rows,process_rows,committed,accepted_total,natural_rejections,forced_truncations,accepted_total?"true":"false");
    proof.hash=token_hash(proof.tokens);proof.target_pos=posmax(target);proof.draft_pos=posmax(draft);
    if(proof.tokens.size()!=size_t(committed)) return fail("token_proof_count");
    proof.before_wrapper_drop=memory();
    std::fflush(stdout);return true;
}

int main(int argc, char ** argv) {
    if (argc != 2 || std::strcmp(argv[1], "--request-isolation") != 0) return 64;
    std::signal(SIGALRM, timed_out);
    alarm(170); // Root's separate admission and outer cleanup remain required.
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
    // One model stays loaded; each request constructs/destroys fresh target+draft+wrapper.
    RequestProof proofs[2];bool requests_ok=true,any_decode=false;int completed=0;
    for(int request=0;request<2;++request) {
        std::printf("{\"stage\":\"request_start\",\"request\":%d,\"sameLoadedModel\":true,\"freshContextsAndWrapper\":true}\n",request);
        std::fflush(stdout);
        const Memory before=memory();
        llama_context_params cp=llama_context_default_params();
        cp.n_ctx=8192;cp.n_batch=512;cp.n_ubatch=512;
        cp.n_threads=3;cp.n_threads_batch=3;cp.n_seq_max=1;cp.n_rs_seq=1;
        capture_stage.store(1,std::memory_order_relaxed);
        llama_context * target=llama_init_from_model(model,cp);
        capture_stage.store(0,std::memory_order_relaxed);
        const Memory after_target=memory();
        llama_context * draft=nullptr;
        if(target) {
            cp.n_ubatch=64;cp.n_rs_seq=0;cp.ctx_type=LLAMA_CONTEXT_TYPE_MTP;
            capture_stage.store(2,std::memory_order_relaxed);
            draft=llama_init_from_model(model,cp);
            capture_stage.store(0,std::memory_order_relaxed);
        }
        const Memory after_draft=memory();
        const bool target_ok=target!=nullptr,draft_ok=draft!=nullptr;
        synthetic_decode_called=false;
        capture_stage.store(3,std::memory_order_relaxed);
        const bool ok=target && draft && synthetic_k1(model,target,draft,proofs[request]);
        capture_stage.store(0,std::memory_order_relaxed);
        any_decode=any_decode || synthetic_decode_called;
        // synthetic_k1's resource destructor has already freed this request's wrapper+batch.
        const Memory before_drop=memory();
        if(draft) llama_free(draft);
        if(target) llama_free(target);
        const Memory after_drop=memory();
        std::printf("{\"stage\":\"request_dropped\",\"request\":%d,",request);
        print_memory("beforeContexts",before);print_memory("afterTarget",after_target);
        print_memory("afterDraft",after_draft);print_memory("beforeContextDrop",before_drop);
        print_memory("beforeWrapperAndContextDrop",proofs[request].before_wrapper_drop);
        print_memory("afterContextDrop",after_drop);
        std::printf("\"targetCreated\":%s,\"draftCreated\":%s,\"requestPassed\":%s,\"generationInvoked\":%s,\"committedTokens\":%zu,\"committedTokenHash\":\"%016llx\",\"targetPosMax\":%d,\"draftPosMax\":%d}\n",
            target_ok?"true":"false",draft_ok?"true":"false",ok?"true":"false",synthetic_decode_called?"true":"false",proofs[request].tokens.size(),
            (unsigned long long)proofs[request].hash,int(proofs[request].target_pos),int(proofs[request].draft_pos));
        std::fflush(stdout);
        if(!ok) { requests_ok=false;break; } // No hidden retry or model reload on failure.
        ++completed;
    }
    const bool comparable=requests_ok && completed==2;
    const bool same=comparable && proofs[0].tokens==proofs[1].tokens
        && proofs[0].hash==proofs[1].hash && proofs[0].target_pos==proofs[1].target_pos
        && proofs[0].draft_pos==proofs[1].draft_pos;
    llama_model_free(model);llama_backend_free();
    char final_log[sizeof(native_log)];
    while(log_lock.test_and_set(std::memory_order_acquire)) {}
    std::memcpy(final_log,native_log,sizeof(final_log));
    const bool truncated=log_truncated;log_lock.clear(std::memory_order_release);
    const auto seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-began).count();
    std::printf("{\"schema\":\"mtp-fresh-request-isolation-v1\",\"passed\":%s,\"requestsCompleted\":%d,\"modelLoadCalls\":1,\"sameModelFreshContexts\":true,\"tokenHashAlgorithm\":\"fnv1a64_le_i32_tokens_then_le_u64_count\",\"exactTokenVectorsCompared\":%s,\"tokenHashesAndPositionsEqual\":%s,\"prefillTokensPerRequest\":513,\"maxAnswerTokensPerRequest\":8,\"maxAnswerTokensTotal\":16,\"generationInvoked\":%s,\"seconds\":%.6f,\"dataLimitBytes\":%llu,\"directContextReuse\":false,\"savedPrefixOrNativeCarry\":false,\"clinicalInputsRead\":false,\"productionGrammarEogSandboxValidated\":false,\"performanceClaim\":false,\"nativeLogTruncated\":%s,\"nativeDiagnosticLog\":",
        same?"true":"false",completed,comparable?"true":"false",same?"true":"false",any_decode?"true":"false",seconds,(unsigned long long)DATA_LIMIT,truncated?"true":"false");
    print_json_string(final_log);std::puts("}");std::fflush(stdout);alarm(0);
    return same?0:4;
}
