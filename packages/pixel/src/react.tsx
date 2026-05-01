/**
 * React error boundary that reports caught render errors to the active
 * pixel adapter. Drop this near the root of your tree to catch render-time
 * crashes — `window.onerror` does NOT fire for these, since React 16+ swallows
 * them internally. An Error Boundary is the only escape hatch.
 *
 * Usage:
 *   import { PixelErrorBoundary } from "@prestyj/pixel/react";
 *
 *   <PixelErrorBoundary fallback={<p>Something broke.</p>}>
 *     <App />
 *   </PixelErrorBoundary>
 *
 * For Next.js, prefer dropping this into `app/global-error.tsx` since that's
 * the framework-blessed top-level boundary.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportPixel } from "./browser.js";

export interface PixelErrorBoundaryProps {
  children: ReactNode;
  /** Static node or render function. If omitted, renders nothing on error. */
  fallback?: ReactNode | ((error: Error) => ReactNode);
  /** Called after pixel reports the error — useful for resetting state. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export class PixelErrorBoundary extends Component<PixelErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Wrap in try/catch — pixel must never break the host app's error UI.
    try {
      reportPixel({ message: error.message, error, level: "fatal" });
    } catch {
      // swallow
    }
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      const { fallback } = this.props;
      if (typeof fallback === "function") return fallback(this.state.error);
      return fallback ?? null;
    }
    return this.props.children;
  }
}
