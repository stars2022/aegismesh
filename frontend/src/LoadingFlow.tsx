import "./LoadingFlow.css";

export function FlowMark({ className = "" }: { className?: string }) {
  return <span className={`flow-mark flow-sweep ${className}`} aria-hidden="true" />;
}

export function LoadingFlow({
  label,
  canvas = false,
  fullPage = false,
}: {
  label: string;
  canvas?: boolean;
  fullPage?: boolean;
}) {
  return (
    <div className={`loading-flow ${canvas ? "loading-flow-canvas" : ""} ${fullPage ? "loading-flow-page" : ""}`} role="status" aria-live="polite">
      {canvas ? (
        <div className="loading-flow-sheet" aria-hidden="true">
          <span className="flow-line flow-sweep flow-line-title" />
          <span className="flow-line flow-sweep flow-line-lead" />
          <span className="flow-line flow-sweep flow-line-wide" />
          <span className="flow-line flow-sweep flow-line-wide" />
          <span className="flow-line flow-sweep flow-line-short" />
        </div>
      ) : <FlowMark />}
      <span className="loading-flow-label flow-sweep">{label}</span>
    </div>
  );
}
