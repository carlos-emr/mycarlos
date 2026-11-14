// GRAMMAR/EOG/CAP SOURCE ONLY: not compiled or run by Astra; Root admission required.
// Batch512 matches actual878d model_helper.rs:69; initial requested256 did not.
// Two fresh non-clinical grammar/EOG/cap requests, each with 33 prefill tokens.
// Reuses the pinned native archives; does not change the production helper or sandbox.
#include "llama.h"
#include "wrapper_common.h"
#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>
#include <string>
#include <exception>
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
static std::atomic<int> capture_stage{0}; // Constructor/request WARN/ERROR only; model-load logs are discarded.
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


static constexpr char EXPECTED[] = "{\"ok\":\"v7Qz\"}";
static constexpr char GRAMMAR[] = R"gbnf(root ::= "{\"ok\":\"v7Qz\"}")gbnf";
struct Counts {
    unsigned emitted=0, picks=0, scans=0, grammar_accepts=0, eog_picks=0;
    unsigned drafted=0, submitted=0, accepted=0, rejected=0, rollback=0, decoded=0;
    unsigned rounds=0, grammar_invalid_rejections=0, natural_rejections=0, eog_clipped=0;
};
struct Request {
    llama_context * target=nullptr;
    llama_context * draft=nullptr;
    llama_rs_mtp_speculative * spec=nullptr;
    llama_sampler * grammar=nullptr;
    llama_batch batch{};
    ~Request() {
        if (grammar) llama_sampler_free(grammar);
        if (batch.token) llama_batch_free(batch);
        if (target) llama_memory_clear(llama_get_memory(target),true);
        if (draft) llama_memory_clear(llama_get_memory(draft),true);
        if (spec) llama_rs_mtp_speculative_free(spec);
        if (draft) llama_free(draft);
        if (target) llama_free(target);
    }
};
// Mirrors Engine.pick_from/first_best: EOG is included, ties retain first ID,
// test greedy singleton first, then filter finite scores after full grammar apply.
static bool production_pick(llama_context * target,const llama_vocab * vocab,
        llama_sampler * grammar,int row,Counts & count,llama_token & selected) {
    ++count.picks;
    const float * logits=llama_get_logits_ith(target,row);
    if (!logits) return false;
    const int n=llama_vocab_n_tokens(vocab);
    selected=llama_vocab_eos(vocab);
    if (n>0) {
        llama_token best=0;float score=logits[0];
        for(int i=1;i<n;++i) if(logits[i]>score) { best=i;score=logits[i]; }
        llama_token_data one{best,score,0.0f};
        llama_token_data_array alone{&one,1,-1,false};
        llama_sampler_apply(grammar,&alone);
        if(alone.size && std::isfinite(alone.data[0].logit)) selected=best;
        else {
            ++count.scans;
            std::vector<llama_token_data> entries;
            entries.reserve(n);
            for(int i=0;i<n;++i) entries.push_back({i,logits[i],0.0f});
            llama_token_data_array all{entries.data(),entries.size(),-1,false};
            llama_sampler_apply(grammar,&all);
            bool found=false;float top=0.0f;
            for(size_t i=0;i<all.size;++i) {
                const auto & item=all.data[i];
                if(std::isfinite(item.logit) && (!found || item.logit>top)) {
                    selected=item.id;top=item.logit;found=true;
                }
            }
        }
    }
    if(selected<0 || selected>=n) return false;
    if(llama_vocab_is_eog(vocab,selected)) ++count.eog_picks;
    return true;
}
static bool grammar_allows(llama_sampler * grammar,llama_token token) {
    // Observation only. Applying a non-lazy grammar never accepts the candidate.
    llama_token_data one{token,0.0f,0.0f};
    llama_token_data_array array{&one,1,-1,false};
    llama_sampler_apply(grammar,&array);
    return array.size && std::isfinite(array.data[0].logit);
}
static bool commit_token(const llama_vocab * vocab,llama_sampler * grammar,
        llama_token token,Counts & count,std::string & written) {
    if(token<0 || token>=llama_vocab_n_tokens(vocab) || llama_vocab_is_eog(vocab,token)) return false;
    // Production's common-enabled accept uses this wrapper. Fail closed on an exception.
    if(llama_rs_sampler_accept(grammar,token)!=LLAMA_RS_STATUS_OK) return false;
    ++count.grammar_accepts;
    char piece[128];
    const int n=llama_token_to_piece(vocab,token,piece,sizeof(piece),0,false);
    if(n<0 || size_t(n)>sizeof(piece) || written.size()+size_t(n)>sizeof(EXPECTED)-1) return false;
    written.append(piece,size_t(n));++count.emitted;
    return std::memcmp(EXPECTED,written.data(),written.size())==0;
}
static bool grammar_request(llama_model * model,unsigned request_id,unsigned max,bool expect_cap) {
    Request r;Counts s;std::string written;
    const auto fail=[&](const char * stage) {
        std::printf("{\"request\":%u,\"stage\":\"%s\",\"passed\":false}\n",request_id,stage);
        std::fflush(stdout);return false;
    };
    llama_context_params cp=llama_context_default_params();
    cp.n_ctx=8192;cp.n_batch=512;cp.n_ubatch=512;
    cp.n_threads=3;cp.n_threads_batch=3;cp.n_seq_max=1;cp.n_rs_seq=1;
    capture_stage.store(1,std::memory_order_relaxed);
    r.target=llama_init_from_model(model,cp);
    if(!r.target) return fail("target_context");
    cp.n_ubatch=64;cp.n_rs_seq=0;cp.ctx_type=LLAMA_CONTEXT_TYPE_MTP;
    capture_stage.store(2,std::memory_order_relaxed);
    r.draft=llama_init_from_model(model,cp);
    if(!r.draft) return fail("draft_context");
    capture_stage.store(3,std::memory_order_relaxed);
    const bool causal=llama_get_causal_attn(r.draft);
    if(!causal || llama_n_ctx(r.target)!=8192 || llama_n_ctx(r.draft)!=8192 ||
       llama_n_batch(r.target)!=512 || llama_n_batch(r.draft)!=512 ||
       llama_n_ubatch(r.target)!=512 || llama_n_ubatch(r.draft)!=64 ||
       llama_n_rs_seq(r.target)!=1 || llama_n_rs_seq(r.draft)!=0) return fail("context_bounds");
    const auto * vocab=llama_model_get_vocab(model);
    const int n_vocab=llama_vocab_n_tokens(vocab);
    r.spec=llama_rs_mtp_speculative_init(r.target,r.draft,1,0,0.0f);
    if(!r.spec) return fail("spec_init");
    llama_memory_clear(llama_get_memory(r.target),true);
    llama_memory_clear(llama_get_memory(r.draft),true);
    r.grammar=llama_rs_sampler_init_grammar(vocab,GRAMMAR,"root");
    if(!r.grammar) return fail("grammar_init");
    r.batch=llama_batch_init(512,0,1);
    if(!r.batch.token || !r.batch.pos || !r.batch.n_seq_id || !r.batch.seq_id || !r.batch.logits) return fail("batch_init");
    const auto fill=[&](const llama_token * tokens,int n,llama_pos pos,bool all) {
        r.batch.n_tokens=n;
        for(int i=0;i<n;++i) {
            r.batch.token[i]=tokens[i];r.batch.pos[i]=pos+i;
            r.batch.n_seq_id[i]=1;r.batch.seq_id[i][0]=0;r.batch.logits[i]=all || i==n-1;
        }
    };
    const auto posmax=[](llama_context * c) {return llama_memory_seq_pos_max(llama_get_memory(c),0);};
    const auto trim=[&](llama_context * c,llama_pos end) {
        return end>0 && llama_memory_seq_rm(llama_get_memory(c),0,end,-1) && posmax(c)==end-1;
    };
    llama_token seed[64];
    static constexpr char prompt[]=" Synthetic format calibration: output the required JSON literal. ";
    const int seed_n=llama_tokenize(vocab,prompt,sizeof(prompt)-1,seed,64,false,false);
    if(seed_n<=0 || seed_n>64) return fail("tokenize");
    for(int i=0;i<seed_n;++i) if(seed[i]<0 || seed[i]>=n_vocab || llama_vocab_is_eog(vocab,seed[i])) return fail("seed");
    std::vector<llama_token> history(33);
    for(size_t i=0;i<history.size();++i) history[i]=seed[i%seed_n];
    fill(history.data(),33,0,false);
    if(llama_decode(r.target,r.batch)!=0) return fail("target_prefill");
    if(llama_rs_mtp_speculative_process(r.spec,&r.batch)!=LLAMA_RS_STATUS_OK) return fail("draft_prefill");
    if(posmax(r.target)!=32 || posmax(r.draft)!=32) return fail("prefill_positions");
    if(llama_rs_mtp_speculative_begin(r.spec,history.data(),history.size())!=LLAMA_RS_STATUS_OK) return fail("begin");
    llama_token pending=LLAMA_TOKEN_NULL;
    if(!production_pick(r.target,vocab,r.grammar,32,s,pending)) return fail("initial_pick");
    llama_pos position=33;bool capped=false,terminal_eog=false;
    while(true) {
        if(llama_vocab_is_eog(vocab,pending)) {terminal_eog=true;break;}
        if(s.emitted>=max || !commit_token(vocab,r.grammar,pending,s,written)) return fail("pending_commit");
        fill(&pending,1,position,true);
        if(s.emitted==max) {
            // Production cap path: decode committed pending token; no draft or bonus pick.
            if(llama_decode(r.target,r.batch)!=0) return fail("cap_decode");
            ++s.decoded;
            if(llama_rs_mtp_speculative_process(r.spec,&r.batch)!=LLAMA_RS_STATUS_OK) return fail("cap_process");
            if(posmax(r.target)!=position || posmax(r.draft)!=position) return fail("cap_positions");
            capped=true;break;
        }
        llama_token proposal=LLAMA_TOKEN_NULL;size_t drafted=0;
        if(llama_rs_mtp_speculative_draft(r.spec,position,pending,history.data(),history.size(),&proposal,1,&drafted)!=LLAMA_RS_STATUS_OK ||
           drafted!=1 || proposal<0 || proposal>=n_vocab) return fail("draft");
        ++s.rounds;++s.drafted;
        if(s.rounds>max) return fail("round_bound");
        const unsigned room=max-s.emitted;
        const bool proposal_eog=llama_vocab_is_eog(vocab,proposal);
        const unsigned submitted=(!proposal_eog && room>0)?1:0;
        if(proposal_eog) ++s.eog_clipped;
        s.submitted+=submitted;
        const llama_token inputs[2]={pending,proposal};fill(inputs,1+submitted,position,true);
        if(!trim(r.draft,position)) return fail("draft_provisional_trim");
        if(llama_decode(r.target,r.batch)!=0) return fail("verify_decode");
        s.decoded+=1+submitted;
        if(posmax(r.target)!=position+int(submitted)) return fail("verify_position");
        if(llama_rs_mtp_speculative_process(r.spec,&r.batch)!=LLAMA_RS_STATUS_OK) return fail("verify_process");
        if(posmax(r.draft)!=position+int(submitted)) return fail("process_position");
        unsigned accepted=0;llama_token next=LLAMA_TOKEN_NULL;
        bool eog=false,cap=false;
        // Same stop ordering as production verify_prefix: room first, then pick/EOG/match.
        while(true) {
            if(accepted==room) {cap=true;break;}
            llama_token selected=LLAMA_TOKEN_NULL;
            if(!production_pick(r.target,vocab,r.grammar,int(accepted),s,selected)) return fail("verify_pick");
            if(llama_vocab_is_eog(vocab,selected)) {eog=true;break;}
            if(accepted>=submitted || selected!=proposal) {next=selected;break;}
            if(!commit_token(vocab,r.grammar,selected,s,written)) return fail("accepted_commit");
            ++accepted;
        }
        if(accepted<submitted) {
            ++s.natural_rejections;
            if(!grammar_allows(r.grammar,proposal)) ++s.grammar_invalid_rejections;
        }
        const llama_pos end=position+1+int(accepted);
        if(accepted<submitted) {
            if(!trim(r.target,end)) return fail("target_rollback");
            s.rollback+=submitted-accepted;
        } else if(posmax(r.target)!=end-1) return fail("accepted_position");
        if(!trim(r.draft,end)) return fail("draft_accepted_trim");
        if(llama_rs_mtp_speculative_accept(r.spec,uint16_t(accepted))!=LLAMA_RS_STATUS_OK) return fail("accept");
        s.accepted+=accepted;s.rejected+=1-accepted;
        history.push_back(pending);if(accepted) history.push_back(proposal);
        position=end;if(history.size()!=size_t(position)) return fail("history");
        std::printf("{\"request\":%u,\"stage\":\"grammar_round\",\"round\":%u,\"submitted\":%u,\"accepted\":%u,\"proposalEogClipped\":%s,\"targetEogSelected\":%s,\"capped\":%s,\"committedTokens\":%u}\n",
            request_id,s.rounds,submitted,accepted,proposal_eog?"true":"false",eog?"true":"false",cap?"true":"false",s.emitted);
        std::fflush(stdout);
        if(cap) {capped=true;break;}
        if(eog) {terminal_eog=true;break;}
        if(next<0 || next>=n_vocab) return fail("progress");
        pending=next;
    }
    const bool exact=written==EXPECTED;
    const bool proper_prefix=!written.empty() && written.size()<sizeof(EXPECTED)-1 &&
        std::memcmp(EXPECTED,written.data(),written.size())==0;
    const bool accounting=s.picks==s.emitted+unsigned(!capped) && s.grammar_accepts==s.emitted &&
        s.decoded==s.emitted+s.rollback && s.submitted==s.accepted+s.rollback && s.drafted==s.accepted+s.rejected;
    const bool boundary=posmax(r.target)==33+int(s.emitted)-1 && posmax(r.draft)==33+int(s.emitted)-1;
    const bool passed=accounting && boundary && (expect_cap ?
        (capped && !terminal_eog && s.emitted==2 && s.eog_picks==0 && proper_prefix) :
        (!capped && terminal_eog && s.eog_picks==1 && exact && s.emitted<=max));
    std::printf("{\"request\":%u,\"stage\":\"grammar_request_complete\",\"passed\":%s,\"maxTokens\":%u,\"capped\":%s,\"terminalEog\":%s,\"exactLiteral\":%s,\"properLiteralPrefix\":%s,\"output\":",
        request_id,passed?"true":"false",max,capped?"true":"false",terminal_eog?"true":"false",exact?"true":"false",proper_prefix?"true":"false");
    print_json_string(written.c_str());
    std::printf(",\"committedTokens\":%u,\"pickCalls\":%u,\"grammarAccepts\":%u,\"grammarFullScans\":%u,\"targetEogSelections\":%u,\"naturalRejections\":%u,\"naturalGrammarInvalidRejections\":%u,\"eogProposalClips\":%u,\"targetDecodeTokens\":%u,\"rollbackTokens\":%u,\"accountingPassed\":%s,\"noBonusPickWhenCapped\":%s,\"targetPosMax\":%d,\"draftPosMax\":%d,\"draftCausalActual\":true,\"prefillRows\":33,\"forcedRejections\":0,\"clinicalInputsRead\":false,\"productionSandboxReproduced\":false,\"performanceClaim\":false}\n",
        s.emitted,s.picks,s.grammar_accepts,s.scans,s.eog_picks,s.natural_rejections,s.grammar_invalid_rejections,s.eog_clipped,s.decoded,s.rollback,
        accounting?"true":"false",(capped && s.picks==s.emitted)?"true":"false",int(posmax(r.target)),int(posmax(r.draft)));
    std::fflush(stdout);return passed;
}
int main(int argc, char ** argv) {
    if (argc != 2 || std::strcmp(argv[1], "--grammar-eog-cap") != 0) return 64;
    std::signal(SIGALRM, timed_out);
    alarm(110); // Root's separate admission and outer cleanup remain required.
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

    bool normal_ok=false,cap_ok=false;
    try {
        normal_ok=grammar_request(model,0,32,false);
        capture_stage.store(0,std::memory_order_relaxed);
        if(normal_ok) cap_ok=grammar_request(model,1,2,true);
    } catch(const std::exception &) {
        std::puts("{\"stage\":\"request_exception\",\"passed\":false}");
    }
    capture_stage.store(0,std::memory_order_relaxed);
    llama_model_free(model);llama_backend_free();
    char final_log[sizeof(native_log)];
    while(log_lock.test_and_set(std::memory_order_acquire)) {}
    std::memcpy(final_log,native_log,sizeof(final_log));const bool truncated=log_truncated;
    log_lock.clear(std::memory_order_release);
    std::printf("{\"stage\":\"grammar_eog_cap_complete\",\"passed\":%s,\"normalPassed\":%s,\"capPassed\":%s,\"modelLoads\":1,\"freshRequestsCompleted\":%u,\"dataLimitBytes\":%llu,\"nativeLogTruncated\":%s,\"nativeLog\":",
        (normal_ok && cap_ok)?"true":"false",normal_ok?"true":"false",cap_ok?"true":"false",unsigned(normal_ok)+unsigned(cap_ok),
        (unsigned long long)DATA_LIMIT,truncated?"true":"false");
    print_json_string(final_log);std::puts("}");std::fflush(stdout);alarm(0);
    return normal_ok && cap_ok ? 0 : 4;
}
