/**
 * Where myCarlos keeps vaults set aside (#71), and how one is removed, by
 * platform. myCarlos never removes one itself. On a computer the folder is
 * named as each system's file app takes it in its address bar, so the path
 * can be copied there; it is not asked of the native side, which gives the
 * screen no paths. On a phone the folder is private to the app.
 */
const SET_ASIDE_FOLDERS: Readonly<Record<string, string>> = {
  windows: "%LOCALAPPDATA%\\ca.carlos.mycarlos\\vault-home\\set-aside",
  macos:
    "~/Library/Application Support/ca.carlos.mycarlos/vault-home/set-aside",
  linux: "~/.local/share/ca.carlos.mycarlos/vault-home/set-aside",
};

const PHONES = new Set(["android", "ios"]);

/** Says who can still open a vault set aside, and how to remove it here. */
export function SetAsideRemoval({ platform }: { platform: string }) {
  const folder = SET_ASIDE_FOLDERS[platform];
  const why =
    "If you are starting again because someone else may know your passphrase, they can still open the vault set aside, so remove it.";
  if (folder)
    return (
      <p className="set-aside-removal">
        {why} To remove a vault set aside, and free its space, close myCarlos
        and delete its folder in <code className="copyable-path">{folder}</code>
        {platform === "linux" ? " (or under $XDG_DATA_HOME, if it is set)" : ""}
        .
      </p>
    );
  if (PHONES.has(platform))
    return (
      <p className="set-aside-removal">
        {why} On this phone, though, vaults set aside stay in myCarlos&apos;s
        private storage, and myCarlos cannot remove them. The only way is to
        clear myCarlos&apos;s data in the phone&apos;s settings, or to uninstall
        it, and that removes every vault on the phone, the one you use too.
      </p>
    );
  return (
    <p className="set-aside-removal">
      {why} Removing it is done outside myCarlos.
    </p>
  );
}
