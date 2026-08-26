import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

type AdaptiveValueProps = {
  children: ReactNode;
  minFontSize?: number;
  maxFontSize?: number;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
};

/**
 * 用于金额、比例等不能被截断的单行数值。
 * 普通标题/按钮使用 CSS 容器查询；只有动态数值需要这个测量型原语。
 */
export function AdaptiveValue({
  children,
  minFontSize = 20,
  maxFontSize = 32,
  className = "",
  style,
  ariaLabel,
}: AdaptiveValueProps) {
  const nodeRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(maxFontSize);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    const fit = () => {
      let next = maxFontSize;
      node.style.whiteSpace = "nowrap";
      node.style.overflowWrap = "normal";
      node.style.fontSize = `${next}px`;
      while (next > minFontSize && node.scrollWidth > node.clientWidth) {
        next -= 1;
        node.style.fontSize = `${next}px`;
      }
      if (node.scrollWidth > node.clientWidth) {
        const ratio = node.clientWidth / node.scrollWidth;
        next = Math.max(12, Math.floor(next * ratio));
        node.style.fontSize = `${next}px`;
      }
      setFontSize(next);
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [children, maxFontSize, minFontSize]);

  return (
    <span
      ref={nodeRef}
      className={`adaptive-value adaptive-value-fit ${className}`.trim()}
      style={{ ...style, fontSize, whiteSpace: "nowrap", overflowWrap: "normal" }}
      aria-label={ariaLabel}
    >
      {children}
    </span>
  );
}
