'use client';
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="state" role="alert">
      <h1>문제가 발생했습니다 / Something went wrong</h1>
      {error.digest && <p className="mono small">ref: {error.digest}</p>}
      <button className="btn primary" onClick={reset}>
        다시 시도 / Retry
      </button>
    </div>
  );
}
