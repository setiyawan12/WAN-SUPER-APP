import { useSyncExternalStore, type CSSProperties } from "react";

// ---------------------------------------------------------------- Toasts

type ToastType = "success" | "error" | "info";
interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

let items: ToastItem[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit() {
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function push(type: ToastType, message: string) {
  const id = ++seq;
  items = [...items, { id, type, message }];
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, 4200);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Fire a toast from anywhere: toast.success("Saved"), toast.error("Failed"). */
export const toast = {
  success: (m: string) => push("success", m),
  error: (m: string) => push("error", m),
  info: (m: string) => push("info", m),
};

const ICONS: Record<ToastType, string> = { success: "✓", error: "!", info: "i" };

/** Mount once (in App). Renders the stacked toasts bottom-right. */
export function Toasts() {
  const snap = useSyncExternalStore(subscribe, () => items);
  return (
    <div className="toast-wrap">
      {snap.map((t) => (
        <div key={t.id} className={`toast ${t.type}`} onClick={() => dismiss(t.id)}>
          <span className="toast-ico">{ICONS[t.type]}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------- Skeleton

/** Shimmering placeholder block used while data loads. */
export function Skeleton({
  w = "100%",
  h = 14,
  r = 8,
  style,
}: {
  w?: string | number;
  h?: string | number;
  r?: number;
  style?: CSSProperties;
}) {
  return <span className="skeleton" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

/** A card-shaped stack of skeleton lines. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card" style={{ gap: 12 }}>
      <Skeleton w="45%" h={16} />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} w={`${90 - i * 12}%`} />
      ))}
    </div>
  );
}

/** Repeated row skeletons for lists (models, providers, etc.). */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="model-row" style={{ borderStyle: "solid" }}>
          <Skeleton w="55%" h={13} />
          <Skeleton w={40} h={20} r={999} />
        </div>
      ))}
    </div>
  );
}
