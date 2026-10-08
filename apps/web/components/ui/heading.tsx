'use client';
import { createContext, useContext, type ReactNode } from 'react';

/**
 * Heading level for nested content (cards, states). Sections/rails that render an <h2> provide level 3 to their
 * children; without a provider card titles are <h2>, so a grid right under the page <h1> never skips a level.
 */
const Level = createContext<2 | 3 | 4>(2);

export function HeadingLevel({ level, children }: { level: 2 | 3 | 4; children: ReactNode }) {
  return <Level.Provider value={level}>{children}</Level.Provider>;
}

export function useHeadingLevel() {
  return useContext(Level);
}

/** Heading whose level follows the surrounding HeadingLevel (h2 by default). */
export function AutoHeading({ children, className, style, id }: { children: ReactNode; className?: string; style?: React.CSSProperties; id?: string }) {
  const lvl = useHeadingLevel();
  const H = `h${lvl}` as 'h2' | 'h3' | 'h4';
  return (
    <H className={className} style={style} id={id}>
      {children}
    </H>
  );
}
