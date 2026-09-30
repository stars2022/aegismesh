import { useSyncExternalStore, type ButtonHTMLAttributes } from "react";

const compactQuery = "(max-width: 820px)";
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(compactQuery);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

export function useCompactSidebar() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(compactQuery).matches, () => false);
}

// Keep the same button and SVG mounted so interrupted transitions can reverse
// naturally, and keyboard focus stays on the control that the user activated.
export function SidebarToggle({ side, expanded, label, className = "", ...props }: {
  side: "left" | "right";
  expanded: boolean;
  label: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return <button {...props} type="button" className={`sidebar-toggle ${className}`}
    aria-label={label} title={label} aria-expanded={expanded} data-side={side}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d={side === "left" ? "M9 3v18" : "M15 3v18"} />
      <path className="sidebar-toggle-chevron" d={side === "left" ? "m16 9-3 3 3 3" : "m8 9 3 3-3 3"} />
    </svg>
  </button>;
}
