import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Empty state: a short line, an optional explanation and an optional action. */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-4 py-10 text-center", className)}>
      <p className="max-w-md text-base text-text">{title}</p>
      {description && <p className="mt-2 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
