export function Skeleton({ w, h = 14, r, className, style }: { w?: number | string; h?: number | string; r?: number | string; className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className ?? ''}`} style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden="true" />;
}

export function CardSkeleton() {
  return (
    <div aria-hidden="true" className="lcard">
      <div className="skeleton sk-media" />
      <div>
        <Skeleton w="70%" h={16} />
        <Skeleton w="45%" h={12} style={{ marginTop: 8 }} />
        <Skeleton w="35%" h={14} style={{ marginTop: 10 }} />
      </div>
    </div>
  );
}

export function CardGridSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div className="grid" role="status" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card flat row nowrap" aria-hidden="true">
          <Skeleton w={44} h={44} r="50%" />
          <div className="grow">
            <Skeleton w="40%" h={14} />
            <Skeleton w="70%" h={12} style={{ marginTop: 8 }} />
          </div>
          <Skeleton w={72} h={24} r={999} />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="table-wrap" role="status" aria-label="Loading">
      <table aria-hidden="true">
        <thead>
          <tr>{Array.from({ length: cols }, (_, i) => <th key={i}><Skeleton w="60%" h={10} /></th>)}</tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>{Array.from({ length: cols }, (_, c) => <td key={c}><Skeleton w={c === 0 ? '80%' : '55%'} h={12} /></td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="stack-lg">
      <Skeleton w="50%" h={34} />
      <div className="skeleton" style={{ height: 380, borderRadius: 24 }} />
      <div className="grid-2">
        <div className="stack">
          <Skeleton w="80%" />
          <Skeleton w="90%" />
          <Skeleton w="60%" />
          <Skeleton w="85%" />
        </div>
        <div className="skeleton" style={{ height: 320, borderRadius: 24 }} />
      </div>
    </div>
  );
}
