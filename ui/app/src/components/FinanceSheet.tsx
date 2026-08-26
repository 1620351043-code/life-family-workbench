import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";

type FinanceSheetProps = {
  children: ReactNode;
  onClose: () => void;
  className?: string;
  ariaLabel: string;
};

/**
 * 财务模块统一的移动端 Sheet：键盘返回、焦点回收、Escape、背景点击和下滑关闭都在这里收口。
 */
export function FinanceSheet({ children, onClose, className = "", ariaLabel }: FinanceSheetProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const touchStartRef = useRef<number | null>(null);
  const historyMarkerRef = useRef<string | null>(null);
  const pendingHistoryCleanupRef = useRef<string | null>(null);
  const [dragOffset, setDragOffset] = useState(0);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const historyMarker = historyMarkerRef.current ?? `finance-sheet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (!historyMarkerRef.current) {
      historyMarkerRef.current = historyMarker;
      window.history.pushState({ ...(window.history.state ?? {}), __lifeFinanceSheet: historyMarker }, "", window.location.href);
    }
    pendingHistoryCleanupRef.current = null;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    const closeOnSystemBack = () => {
      historyMarkerRef.current = null;
      pendingHistoryCleanupRef.current = null;
      onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("popstate", closeOnSystemBack);
    window.setTimeout(() => {
      const focusTarget = dialogRef.current?.querySelector<HTMLElement>("button[aria-label^='关闭'], input, select, textarea, button");
      focusTarget?.focus();
    }, 0);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("popstate", closeOnSystemBack);
      if (historyMarkerRef.current === historyMarker) {
        pendingHistoryCleanupRef.current = historyMarker;
        window.setTimeout(() => {
          if (pendingHistoryCleanupRef.current === historyMarker && window.history.state?.__lifeFinanceSheet === historyMarker) {
            pendingHistoryCleanupRef.current = null;
            historyMarkerRef.current = null;
            window.history.back();
          }
        }, 0);
      }
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  const onTouchStart = (event: TouchEvent<HTMLElement>) => {
    if (event.currentTarget.scrollTop > 0) return;
    touchStartRef.current = event.touches[0]?.clientY ?? null;
  };

  const onTouchMove = (event: TouchEvent<HTMLElement>) => {
    if (touchStartRef.current === null) return;
    const delta = event.touches[0]?.clientY - touchStartRef.current;
    if (delta > 0) setDragOffset(Math.min(delta, 120));
  };

  const onTouchEnd = () => {
    if (touchStartRef.current !== null && dragOffset > 72) onCloseRef.current();
    touchStartRef.current = null;
    setDragOffset(0);
  };

  return <div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
    <section
      ref={dialogRef}
      className={`sheet ${className}`.trim()}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      style={dragOffset ? { transform: `translateY(${dragOffset}px)` } : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >{children}</section>
  </div>;
}
