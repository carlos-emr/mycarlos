import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Appearance } from "./appearance";
import { startNativeAppearance } from "./native/nativeAppearance";

const AppearanceContext = createContext<Appearance | null>(null);

export function AppearanceProvider({
  appearance,
  children,
}: {
  appearance: Appearance;
  children: ReactNode;
}) {
  useSyncExternalStore(appearance.subscribe, appearance.snapshot);
  useEffect(() => startNativeAppearance(appearance), [appearance]);
  return (
    <AppearanceContext.Provider value={appearance}>
      {children}
    </AppearanceContext.Provider>
  );
}

export const useAppearance = () => useContext(AppearanceContext);
