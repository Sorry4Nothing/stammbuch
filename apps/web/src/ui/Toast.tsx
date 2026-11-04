import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import type { Tone } from "./Badge";
import { Button } from "./Button";
import { Message } from "./Message";

export const TOAST_DURATION_MS = 5000;

interface ToastItem {
  id: number;
  tone: Tone;
  title?: string;
  text?: string;
}

interface ToastApi {
  show: (toast: Omit<ToastItem, "id">) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Toasts unten rechts, verschwinden nach 5 Sekunden (Design 11.5). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((list) => list.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      const id = next.current++;
      setItems((list) => [...list, { ...toast, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_DURATION_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const live = timers.current;
    return () => live.forEach(clearTimeout);
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toasts" data-keep-active="">
          {items.map((x) => (
            <div key={x.id} className="toast">
              <Message tone={x.tone} title={x.title}>
                {x.text}
              </Message>
              <Button
                variant="ghost"
                small
                icon="close"
                aria-label={t("ui.toast.close")}
                onClick={() => dismiss(x.id)}
              />
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast braucht einen ToastProvider");
  return ctx;
}
