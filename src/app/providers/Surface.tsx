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
  activeModal: HTMLDialogElement | null;
  notificationHost: HTMLElement | null;
  registerModal: (dialog: HTMLDialogElement, notificationHost: HTMLElement) => () => void;
}
interface ModalSurface { dialog: HTMLDialogElement; notificationHost: HTMLElement }
const Context = createContext<Surface | null>(null);
export function SurfaceProvider({ children }: { children: ReactNode }) {
  const [modals, setModals] = useState<ModalSurface[]>([]);
  const registerModal = useCallback((dialog: HTMLDialogElement, notificationHost: HTMLElement) => {
    const entry = { dialog, notificationHost };
    setModals(current => [...current, entry]);
    return () => {
      setModals(current => current.filter(item => item !== entry));
    };
  }, []);
  const value = useMemo(
    () => ({
      surfaceHidden: modals.length > 0,
      activeModal: modals.at(-1)?.dialog ?? null,
      notificationHost: modals.at(-1)?.notificationHost ?? null,
      registerModal,
    }),
    [modals, registerModal],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useSurface() {
  const value = useContext(Context);
  if (!value) throw new Error('SurfaceProvider missing');
  return value;
}
