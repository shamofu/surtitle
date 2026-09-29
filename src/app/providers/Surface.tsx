// SPDX-License-Identifier: GPL-3.0-or-later
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
interface Surface {
  surfaceHidden: boolean;
  registerModal: () => () => void;
}
const Context = createContext<Surface | null>(null);
export function SurfaceProvider({ children }: { children: ReactNode }) {
  const [modalCount, setModalCount] = useState(0);
  const registerModal = useCallback(() => {
    setModalCount((value) => value + 1);
    let registered = true;
    return () => {
      if (registered) {
        registered = false;
        setModalCount((value) => value - 1);
      }
    };
  }, []);
  const value = useMemo(
    () => ({ surfaceHidden: modalCount > 0, registerModal }),
    [modalCount, registerModal],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSurface() {
  const value = useContext(Context);
  if (!value) throw new Error('SurfaceProvider missing');
  return value;
}
