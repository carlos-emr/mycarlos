// The page's end of the cloud AI commands (#72): thin `invoke` calls to src-tauri/src/cloud_ai/
// commands.rs. Present in every build but used only when `cloudAiBuild()` is on, and the commands
// themselves exist only in a build with the `cloud-ai` Cargo feature, which no build may have on
// until the live contract check. No key is ever read back: `addKey` sends one and gets a masked
// entry; a send is named by an exchange id, never by text.

import { invoke } from "@tauri-apps/api/core";
import { getLocale } from "./i18n";
import type {
  CloudAiBridge,
  CloudKeyInfo,
  CloudKeyTest,
  CloudSendAnswer,
  CloudSendPrepared,
} from "./cloudAi";

interface PrepareOutcome {
  prepared: CloudSendPrepared | null;
  hits: { start: number; end: number }[];
}

export const cloudAiNativeBridge: CloudAiBridge = {
  enabled: () => invoke<boolean>("cloud_ai_enabled"),
  setEnabled: (on) => invoke<void>("cloud_ai_set_enabled", { on }),
  listKeys: () => invoke<CloudKeyInfo[]>("cloud_key_list"),
  addKey: (request) => invoke<CloudKeyInfo>("cloud_key_add", { request }),
  removeKey: (id) => invoke<void>("cloud_key_remove", { id }),
  testKey: (id) => invoke<CloudKeyTest>("cloud_key_test", { id }),
  prepare: async (request) => {
    const outcome = await invoke<PrepareOutcome>("cloud_send_prepare", {
      request,
    });
    if (!outcome.prepared) throw { code: "recheck", hits: outcome.hits };
    return outcome.prepared;
  },
  send: (exchangeId) =>
    invoke<CloudSendAnswer>("cloud_send", {
      exchangeId,
      locale: getLocale(),
    }),
  cancel: (exchangeId) => invoke<void>("cloud_send_cancel", { exchangeId }),
};
