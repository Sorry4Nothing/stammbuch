import { Fragment, type ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Text mit Tastaturkürzeln: «Mit [[Strg+S]] speichern Sie» zeigt Strg+S als Tastenhinweis. */
export function KbdText({ children }: { children: string }) {
  return children
    .split(/\[\[(.+?)\]\]/)
    .map((part, i) =>
      i % 2 === 1 ? <Kbd key={i}>{part}</Kbd> : <Fragment key={i}>{part}</Fragment>,
    );
}
